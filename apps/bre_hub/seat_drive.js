'use strict';
/**
 * seat_drive.js - moves the driver's seat: the ONLY file in BRE Hub that writes to the seat module (FAS, 0x6D).
 * Approved by Fabian on 15.11.2026 (docs/07). Reads go through seat_link.js; every write is here.
 *
 * What may leave, and nothing else:
 *   2E D708 <motor> <action> <PWM>   motor 0x00 fore / aft (SLV) or 0x01 height (SHV); action 0x00 STOP,
 *                                    0x01 PLUS (forward / up), 0x02 MINUS (back / down); PWM 100 %
 *                                    (SGBD FAS_G11: MOTOR, ARG_0xD708_D, TAB_MOTOR_AKTION)
 *   10 03                            the extended session, opened before a move (the seat module's workshop jobs run
 *                                    in it: docs/07; on the G30 a 2E in the default session went unanswered), and
 *                                    3E 00 (tester present) every 2 s while the move runs
 *   10 01                            back to the default session when the move ends, whatever happened (it ends any
 *                                    tester control); else the module drops back by itself ~5 s after the last 3E
 * Never: the backrest or any other motor, the Hall counter reset (D722), coding, routines, security access.
 *
 * A move (SeatMover.moveAxis): one axis at a time toward a Hall counter. The motor's direction comes from the
 * probe's LEARNED direction (seat_link.js, never assumed). It stops - and STOP is always sent - when:
 *   the counter is at the target (STOP early by the seat's speed x a request's time); it went the wrong way; it
 *   stopped moving (an end stop, a blockage, or a command that was never answered and did nothing); the axis's
 *   time ran out; one of the seat's own switches was touched (they win); guard() said no (not parked, disarmed);
 *   stop() was called; the module refused the command; the position stayed unread.
 * Waiting rather than giving up (Fabian, 15.11.2026): an unanswered command is sent again (3 s each), and then
 * the position tells whether it was taken; a position read that fails STOPS the motor (it never runs unseen)
 * until the position is read again, then the move goes on.
 * The motor command is sent again every second while the move runs, so a module that drops a tester's command
 * after a while keeps moving only while the app is there.
 */
const { hex, NRC, replyTo } = require('./kit/diag');
const { FAS, DID, parseHall, parseSwitches } = require('./seat_link');

const MOTOR = Object.freeze({ slv: 0x00, shv: 0x01 });
const ACTION = Object.freeze({ stop: 0x00, plus: 0x01, minus: 0x02 });
const PWM = 100;

const POLL_MS = 200;            // a position read this often while moving (not faster: the transport is shared)
const RESEND_MS = 1000;         // the motor command again this often
const START_MS = 900;           // a motor gets this long to start moving (relay, inertia) before "no progress" counts
const STALL_MS = 700;           // no progress for this long: an end stop or something in the way
const AXIS_LIMIT_MS = 20000;    // one axis's move ends after this, whatever happens (pauses for reads included)
const TOLERANCE = 6;            // counts: at the target
const LEAD = 3;                 // counts: STOP at least this early, for the coasting
const MAX_LEAD = 40;            // counts: STOP at most this early (the seat's speed x a request's time)
const MAX_MISSES = 6;           // position reads missed in a row (the motor stopped meanwhile) before the move ends
const STOP_MS = 3000;           // a STOP's answer is waited for this long, and an unanswered STOP sent again
const STOP_SENDS = 3;           // up to this many times
const MOVE_MS = 1500;           // a PLUS / MINUS is sent once and waited for this long: then the position tells
                                // (a long wait for a command the module obeys silently would let the motor run unseen)
const MOVE_RETRIES = 2;         // an unanswered PLUS / MINUS after which nothing moved is sent again this often
const WRONG_WAY = 12;           // counts the wrong way that end a move
const NEAR = 25;                // counts: stalled this close to the target is there (a target at the end of the
                                // travel - fully down - may sit a few counts past where the end stop is that day)
const KEEPALIVE_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (b) => b.map((x) => hex(x)).join(' ');

/** The writes, and the session they need. */
class SeatDrive {
    /** link: the DmeLink (its diag and available, once init() ran). */
    constructor(link, log) {
        this.link = link; this.log = log;
        this.extended = false; this._keep = null;
    }

    get available() { return !!(this.link && this.link.available && this.link.diag); }

    /**
     * tries: how often a busy transport is tried again (100, 200 ... ms apart); STOP gets more. urgent: never waits
     * the pause the shared link takes after an unanswered request (dme_link.js pace), only its turn.
     */
    async _send(sid, data, timeoutMs, tries, urgent) {
        const reply = await this.link.diag.physical(FAS, sid, data, timeoutMs || 1500, replyTo(sid, data),
            { maxRetries: tries === undefined ? 2 : tries, retryBaseMs: 100, urgent: !!urgent });
        if (!reply || !reply.length) return { ok: false, nrc: null, reason: 'timeout' };
        if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
        if (reply[0] === sid + 0x40) return { ok: true };
        return { ok: false, nrc: null, reason: 'unexpected ' + hex(reply[0]) };
    }

    /** One motor command: axis 'slv' | 'shv', action 'plus' | 'minus' | 'stop'. Resolves { ok, reason }. */
    async motor(axis, action) {
        if (!Object.prototype.hasOwnProperty.call(MOTOR, axis) || !Object.prototype.hasOwnProperty.call(ACTION, action)) {
            throw new Error('not a seat command: ' + axis + ' ' + action);
        }
        if (!this.available) return { ok: false, reason: 'no diagnostic link' };
        const data = [0xD7, 0x08, MOTOR[axis], ACTION[action], PWM];
        this.log.info('seat: UDS -> FAS 2E ' + bytes(data) + ' (' + axis + ' ' + action + ')');
        // a STOP must get through: it waits longer, for a busy transport and for an answer, and is sent again;
        // a PLUS / MINUS goes once (the move watches the position and sends it again if nothing moved)
        const stop = action === 'stop';
        const tries = stop ? 5 : 2, sends = stop ? STOP_SENDS : 1, waitMs = stop ? STOP_MS : MOVE_MS;
        const once = async () => {
            let a = null;
            for (let i = 0; i < sends; i++) {
                a = await this._send(0x2E, data, waitMs, tries, stop);
                if (a.ok || (a.nrc !== null && a.nrc !== undefined)) return a;      // answered: taken or refused
                if (i + 1 < sends) this.log.warn('seat: ' + axis + ' ' + action + ' unanswered (' + a.reason + '): sent again');
            }
            return a;
        };
        try {
            let r = await once();
            if (!r.ok && (r.nrc === 0x7E || r.nrc === 0x7F) && !this.extended) {
                const s = await this._session();
                if (s.ok) r = await once();
            }
            if (!r.ok) this.log.warn('seat: ' + axis + ' ' + action + ' not taken: ' + r.reason);
            return r;
        } catch (e) {
            this.log.warn('seat: ' + axis + ' ' + action + ': ' + String(e && e.message || e));
            return { ok: false, reason: String(e && e.message || e) };
        }
    }

    /** The extended session (10 03); kept with tester present only while a move runs (keep()). */
    async _session() {
        this.log.info('seat: UDS -> FAS 10 03 (extended session)');
        const r = await this._send(0x10, [0x03], 3000, 4);
        this.extended = !!r.ok;
        if (!r.ok) this.log.warn('seat: extended session not opened: ' + r.reason);
        else this.keep(true);
        return r;
    }

    /** Before a move: the extended session. Resolves { ok, reason }. */
    async begin() {
        if (!this.available) return { ok: false, reason: 'no diagnostic link' };
        try { return await this._session(); } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    }

    /** After a move (STOP already sent): tester present off and the default session (10 01). Never throws. */
    async end() {
        const was = this.extended;
        this.keep(false);
        if (!was || !this.available) return;
        this.log.info('seat: UDS -> FAS 10 01 (default session)');
        try { await this._send(0x10, [0x01], 3000, 4, true); } catch (e) { this.log.warn('seat: default session: ' + e); }
    }

    /** Tester present (3E 00) every 2 s while on; off: the module falls back to its default session by itself. */
    keep(on) {
        clearInterval(this._keep); this._keep = null;
        if (!on) { this.extended = false; return; }
        if (!this.extended) return;
        this._keep = setInterval(() => { this._send(0x3E, [0x00]).catch(() => {}); }, KEEPALIVE_MS);
        if (this._keep.unref) this._keep.unref();
    }

    /** STOP to both motors we drive, whatever happened before. */
    async stopAll() {
        await this.motor('slv', 'stop');
        await this.motor('shv', 'stop');
    }
}

/**
 * Moves toward Hall counters. probe: the SeatProbe (its learned directions); seatLink: the reads; drive: the
 * writes; guard(): true while a move may go on (armed, parked: main.js).
 */
class SeatMover {
    constructor(o) {
        this.probe = o.probe; this.seat = o.seatLink; this.drive = o.drive; this.log = o.log;
        this.guard = o.guard || (() => false);
        this.now = o.now || (() => Date.now());
        this.wait = o.sleep || sleep;
        this.busy = false; this.aborted = false; this.reason = null; this.axis = null;
        // what a running move is doing, for the page: { axis, start, now, target, action, sent } or null
        this.progress = null;
    }

    /** Stop what runs: the move sees it within one poll and sends STOP. */
    stop(reason) { if (this.busy) { this.aborted = true; this.reason = reason || 'stopped'; } }

    /**
     * The position. While a motor runs, read quickly (no tries again: a late position would let it run on unseen);
     * before it starts (settled), the read may try again.
     */
    async _read(settled) {
        const h = await this.seat.read(DID.HALL, null, !settled);
        return h.ok ? parseHall(h.data) : null;
    }

    /** One axis to a counter. Resolves true at the target, false otherwise (this.reason says why). */
    async moveAxis(axis, target) {
        const rises = this.probe.rises[axis];
        if (rises !== 'plus' && rises !== 'minus') { this.reason = 'direction not learned'; return false; }
        if (!this.guard()) { this.reason = 'not allowed now'; return false; }
        const first = await this._read(true);
        const start = first && first[axis];
        if (start === null || start === undefined) { this.reason = 'no position'; return false; }
        if (Math.abs(target - start) <= TOLERANCE) return true;
        const up = target > start;
        const action = up ? rises : (rises === 'plus' ? 'minus' : 'plus');
        this.axis = axis;
        this.log.info('seat: ' + axis + ' ' + start + ' -> ' + target + ' (' + action + ')');
        const t0 = this.now();
        // goneAt: when the motor was (re)started - "no progress" counts from START_MS after it
        let sentAt = t0, goneAt = t0, best = start, bestAt = t0, misses = 0, polls = 0, ok = false;
        let paused = false, answered = true, last = null, speed = 0, retries = MOVE_RETRIES;
        this.progress = { axis: axis, start: start, now: start, target: target, action: action, sent: null };
        // a command: refused (NRC) ends the move; unanswered (timeout) goes on watching the position, which tells
        const send = async () => {
            const w = await this.drive.motor(axis, action);
            if (w.ok) { answered = true; this.progress.sent = true; return true; }
            if (w.nrc !== null && w.nrc !== undefined) { this.reason = 'command refused: ' + w.reason; return false; }
            answered = false; this.progress.sent = null;
            this.log.warn('seat: ' + axis + ' ' + action + ' unanswered (' + w.reason + '): watching the position');
            return true;
        };
        try {
            if (!(await send())) return false;
            for (;;) {
                await this.wait(POLL_MS);
                if (this.aborted) return false;
                if (!this.guard()) { this.reason = 'not allowed now'; return false; }
                const asked = this.now();
                const h = await this._read();
                const now = this.now(), latency = now - asked;
                const v = h && h[axis];
                if (v === null || v === undefined) {
                    // never run unseen: the motor stops until the position is read again, then goes on
                    misses++;
                    if (!paused) { paused = true; await this.drive.motor(axis, 'stop'); this.log.warn('seat: ' + axis + ' position not read: paused'); }
                    if (misses >= MAX_MISSES) { this.reason = 'position not read'; return false; }
                    continue;
                }
                misses = 0;
                this.progress.now = v;
                if (last && now > last.t) speed = Math.abs(v - last.v) / (now - last.t);
                last = { v: v, t: now };
                if (up ? v < start - WRONG_WAY : v > start + WRONG_WAY) { this.reason = 'went the wrong way'; return false; }
                // STOP early by what the seat covers while the STOP is on its way (about one request), never late
                const lead = Math.max(LEAD, Math.min(MAX_LEAD, Math.round(speed * latency)));
                if (up ? v >= target - lead : v <= target + lead) { ok = true; return true; }
                if (paused) {
                    paused = false;
                    if (!(await send())) return false;
                    sentAt = goneAt = bestAt = this.now(); best = v;
                    continue;
                }
                if ((++polls) % 2 === 0) {
                    const s = await this.seat.read(DID.SWITCHES, null, true);
                    if (s.ok && parseSwitches(s.data).pressed) { this.reason = 'a seat switch was touched'; return false; }
                }
                if (up ? v > best + 1 : v < best - 1) { best = v; bestAt = now; }
                if (now - goneAt > START_MS && now - bestAt > STALL_MS) {
                    if (Math.abs(target - v) <= NEAR) { ok = true; return true; }
                    if (!answered && retries > 0) {
                        // unanswered and nothing moved: the command again, and watch again
                        retries--;
                        this.log.warn('seat: ' + axis + ' did not move on an unanswered ' + action + ': sent again');
                        if (!(await send())) return false;
                        sentAt = goneAt = bestAt = this.now(); best = v;
                        continue;
                    }
                    this.reason = answered ? 'no progress (end stop?)' : 'no answer to the command, and the seat did not move';
                    return false;
                }
                if (now - t0 > AXIS_LIMIT_MS) { this.reason = 'time limit'; return false; }
                if (now - sentAt >= RESEND_MS) {
                    sentAt = now;
                    if (!(await send())) return false;
                }
            }
        } finally {
            await this.drive.motor(axis, 'stop');
            this.axis = null; this.progress = null;
            if (!ok) this.log.warn('seat: ' + axis + ' stopped: ' + (this.reason || 'stopped'));
            else this.log.info('seat: ' + axis + ' at ' + target);
        }
    }

    /** Several axes, one after the other: [[axis, counter], ...]. Resolves true when all arrived. */
    async run(steps) {
        if (this.busy) { this.reason = 'already moving'; return false; }
        this.aborted = false; this.reason = null;
        if (!this.guard()) { this.reason = 'not allowed now'; return false; }
        this.busy = true;
        try {
            // the extended session first; without it no motor command goes
            const s = await this.drive.begin();
            if (!s.ok) { this.reason = 'extended session: ' + s.reason; return false; }
            for (const st of steps) {
                if (!(await this.moveAxis(st[0], st[1]))) return false;
            }
            return true;
        } catch (e) {
            this.reason = String(e && e.message || e);
            this.log.error('seat move', e);
            await this.drive.stopAll().catch(() => {});
            return false;
        } finally {
            await this.drive.end();                    // tester present off, the default session (10 01)
            this.busy = false;
        }
    }
}

/**
 * The real backend for Seat Easy Access, in the shape of seats_backend.js's (status, goTo, stop, jog): the driver's
 * seat in fractions (fore 0 front .. 1 back, height 0 down .. 1 up) through the probe's measured ends.
 */
class RealBackend {
    constructor(o) {
        this.probe = o.probe; this.mover = o.mover; this.log = o.log;
        this.mode = 'armed';
    }

    /** Where the driver's seat is, from the last position read (null where unknown). */
    status() {
        const p = this.probe, h = p.hall || {};
        const driver = { pos: { fore: p.fraction('slv', h.slv), height: p.fraction('shv', h.shv), back: null },
            moving: this.mover.busy, job: this.mover.busy ? 'goTo' : null };
        return { mode: this.mode, connected: p.state === 'found',
            seats: { driver: driver, passenger: { pos: { fore: null, height: null, back: null }, moving: false, job: null } } };
    }

    /** The driver's seat to target (fractions; back is not moved). Fore / aft back first, then height. */
    async goTo(seat, target) {
        if (seat !== 'driver') return false;
        // a fresh position before working out the move (one just read, e.g. by Easy Access's refresh, will do)
        if (!this.probe.hallAt || Date.now() - this.probe.hallAt > 1500) await this.probe.tick();
        const now = this.status().seats.driver.pos;
        if (now.fore === null || now.height === null) { this.log.warn('seat: no position or direction yet (Seat module)'); return false; }
        const fore = target.fore === undefined || target.fore === null ? null : this.probe.countFor('slv', target.fore);
        const height = target.height === undefined || target.height === null ? null : this.probe.countFor('shv', target.height);
        const steps = [];
        // going back (getting out): back first, then down; coming forward (getting in): up first, then forward
        const back = target.fore !== null && target.fore !== undefined && target.fore >= now.fore;
        if (back) { if (fore !== null) steps.push(['slv', fore]); if (height !== null) steps.push(['shv', height]); }
        else { if (height !== null) steps.push(['shv', height]); if (fore !== null) steps.push(['slv', fore]); }
        const ok = await this.mover.run(steps);
        await this.probe.tick().catch(() => {});
        return ok;
    }

    stop() { this.mover.stop('stopped'); }
    jog() { /* hold-to-move from the screen: not offered */ }
    close() { this.mover.stop('closing'); }
}

module.exports = { SeatDrive, SeatMover, RealBackend, MOTOR, ACTION, PWM, TOLERANCE, LEAD };
