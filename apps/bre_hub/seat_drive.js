'use strict';
/**
 * seat_drive.js - moves the driver's seat: the ONLY file in BRE Hub that writes to the seat module (FAS, 0x6D).
 * Approved by Fabian on 15.11.2026 (docs/07). Reads go through seat_link.js; every write is here.
 *
 * What may leave, and nothing else:
 *   2E D708 <motor> <action> <PWM>   motor 0x00 fore / aft (SLV) or 0x01 height (SHV); action 0x00 STOP,
 *                                    0x01 PLUS (forward / up), 0x02 MINUS (back / down); PWM 100 %
 *                                    (SGBD FAS_G11: MOTOR, ARG_0xD708_D, TAB_MOTOR_AKTION)
 *   10 03                            the extended session, only when the module refuses 2E in its default one
 *                                    (NRC 7E / 7F), and 3E 00 (tester present) every 2 s only while a move runs;
 *                                    the module drops back to its default session by itself ~5 s after
 * Never: the backrest or any other motor, the Hall counter reset (D722), coding, routines, security access.
 *
 * A move (SeatMover.moveAxis): one axis at a time toward a Hall counter. The motor's direction comes from the
 * probe's LEARNED direction (seat_link.js, never assumed). It stops - and STOP is always sent - when:
 *   the counter is at the target; it went the wrong way; it stopped moving (an end stop, a blockage); the axis's
 *   time ran out; one of the seat's own switches was touched (they win); guard() said no (not parked, disarmed);
 *   stop() was called; a read or a write failed.
 * The motor command is sent again every second while the move runs, so a module that drops a tester's command
 * after a while keeps moving only while the app is there.
 */
const { hex, NRC, replyTo } = require('./kit/diag');
const { FAS, DID, parseHall, parseSwitches } = require('./seat_link');

const MOTOR = Object.freeze({ slv: 0x00, shv: 0x01 });
const ACTION = Object.freeze({ stop: 0x00, plus: 0x01, minus: 0x02 });
const PWM = 100;

const POLL_MS = 150;            // a position read this often while moving
const RESEND_MS = 1000;         // the motor command again this often
const START_MS = 900;           // a motor gets this long to start moving (relay, inertia) before "no progress" counts
const STALL_MS = 700;           // no progress for this long: an end stop or something in the way
const AXIS_LIMIT_MS = 12000;    // one axis's move ends after this, whatever happens
const TOLERANCE = 6;            // counts: at the target
const LEAD = 3;                 // counts: STOP this early, for the coasting
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

    async _send(sid, data, timeoutMs) {
        const reply = await this.link.diag.physical(FAS, sid, data, timeoutMs || 1500, replyTo(sid, data), { maxRetries: 1 });
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
        try {
            let r = await this._send(0x2E, data);
            if (!r.ok && (r.nrc === 0x7E || r.nrc === 0x7F) && !this.extended) {
                const s = await this._session();
                if (s.ok) r = await this._send(0x2E, data);
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
        this.log.info('seat: UDS -> FAS 10 03 (the module asked for the extended session)');
        const r = await this._send(0x10, [0x03]);
        this.extended = !!r.ok;
        if (!r.ok) this.log.warn('seat: extended session refused: ' + r.reason);
        else this.keep(true);
        return r;
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
    }

    /** Stop what runs: the move sees it within one poll and sends STOP. */
    stop(reason) { if (this.busy) { this.aborted = true; this.reason = reason || 'stopped'; } }

    async _read() {
        const h = await this.seat.read(DID.HALL);
        return h.ok ? parseHall(h.data) : null;
    }

    /** One axis to a counter. Resolves true at the target, false otherwise (this.reason says why). */
    async moveAxis(axis, target) {
        const rises = this.probe.rises[axis];
        if (rises !== 'plus' && rises !== 'minus') { this.reason = 'direction not learned'; return false; }
        if (!this.guard()) { this.reason = 'not allowed now'; return false; }
        const first = await this._read();
        const start = first && first[axis];
        if (start === null || start === undefined) { this.reason = 'no position'; return false; }
        if (Math.abs(target - start) <= TOLERANCE) return true;
        const up = target > start;
        const action = up ? rises : (rises === 'plus' ? 'minus' : 'plus');
        this.axis = axis;
        this.log.info('seat: ' + axis + ' ' + start + ' -> ' + target + ' (' + action + ')');
        const t0 = this.now();
        let sentAt = t0, best = start, bestAt = t0, misses = 0, polls = 0, ok = false;
        try {
            const w = await this.drive.motor(axis, action);
            if (!w.ok) { this.reason = 'command not taken: ' + w.reason; return false; }
            for (;;) {
                await this.wait(POLL_MS);
                const now = this.now();
                if (this.aborted) return false;
                if (!this.guard()) { this.reason = 'not allowed now'; return false; }
                const h = await this._read();
                const v = h && h[axis];
                if (v === null || v === undefined) {
                    if (++misses >= 2) { this.reason = 'position not read'; return false; }
                    continue;
                }
                misses = 0;
                if ((++polls) % 2 === 0) {
                    const s = await this.seat.read(DID.SWITCHES);
                    if (s.ok && parseSwitches(s.data).pressed) { this.reason = 'a seat switch was touched'; return false; }
                }
                if (up ? v < start - WRONG_WAY : v > start + WRONG_WAY) { this.reason = 'went the wrong way'; return false; }
                if (up ? v >= target - LEAD : v <= target + LEAD) { ok = true; return true; }
                if (up ? v > best + 1 : v < best - 1) { best = v; bestAt = now; }
                if (now - t0 > START_MS && now - bestAt > STALL_MS) {
                    if (Math.abs(target - v) <= NEAR) { ok = true; return true; }
                    this.reason = 'no progress (end stop?)'; return false;
                }
                if (now - t0 > AXIS_LIMIT_MS) { this.reason = 'time limit'; return false; }
                if (now - sentAt >= RESEND_MS) {
                    sentAt = now;
                    const again = await this.drive.motor(axis, action);
                    if (!again.ok) { this.reason = 'command not taken: ' + again.reason; return false; }
                }
            }
        } finally {
            await this.drive.motor(axis, 'stop');
            this.axis = null;
            if (!ok) this.log.warn('seat: ' + axis + ' stopped: ' + (this.reason || 'stopped'));
        }
    }

    /** Several axes, one after the other: [[axis, counter], ...]. Resolves true when all arrived. */
    async run(steps) {
        if (this.busy) { this.reason = 'already moving'; return false; }
        this.busy = true; this.aborted = false; this.reason = null;
        this.drive.keep(true);
        try {
            for (const s of steps) {
                if (!(await this.moveAxis(s[0], s[1]))) return false;
            }
            return true;
        } catch (e) {
            this.reason = String(e && e.message || e);
            this.log.error('seat move', e);
            await this.drive.stopAll().catch(() => {});
            return false;
        } finally {
            this.drive.keep(false);
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
        await this.probe.tick();                       // a fresh position before working out the move
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
