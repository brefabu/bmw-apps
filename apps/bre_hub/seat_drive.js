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
 *                                    in it: docs/07), and 3E 00 (tester present) every 2 s while the move runs
 *   10 01                            back to the default session when the move ends, whatever happened (it ends any
 *                                    tester control); else the module drops back by itself ~5 s after the last 3E
 * Never: the backrest or any other motor, the Hall counter reset (D722), coding, routines, security access.
 *
 * A move works by the seat's SPEED (Fabian's idea, 15.11.2026): on the G30 the position could not be read while a
 * motor command was under way (the transport turned the reads away), so nothing is read while a motor runs.
 *   - Speed test (measureSpeed): each axis MINUS for TEST_MS, then PLUS for TEST_MS, the position read only with the
 *     motor stopped: counts per millisecond per axis and direction, kept with the probe (bre_seat_travel.json). The
 *     test also checks the learned direction: a seat that went the other way drops it and stops.
 *   - A move (moveAxis): the position read with the motor stopped; a PULSE of distance / speed (the first one aiming
 *     at FIRST_SHARE of the way, so it falls short rather than past), then STOP, a pause, the position again, and a
 *     correcting pulse, MAX_PULSES at most. Each pulse refines the speed.
 *   - A pulse is timed from when its command was sent; meanwhile the app checks, without a request, every
 *     GUARD_MS: Stop pressed, the car not parked (guard()), the command refused - any of them sends STOP at once.
 *   - After each pulse: the wrong way drops the direction and stops; a seat that did not move stops ("the seat did
 *     not move") unless it is at the target (an end stop); a seat switch held stops (they win).
 *   - STOP is always sent after a pulse; a pulse never runs past MAX_PULSE_MS.
 */
const { hex, NRC, replyTo } = require('./kit/diag');
const { FAS, DID, parseHall, parseSwitches } = require('./seat_link');

const MOTOR = Object.freeze({ slv: 0x00, shv: 0x01 });
const ACTION = Object.freeze({ stop: 0x00, plus: 0x01, minus: 0x02 });
const PWM = 100;

const TOLERANCE = 6;            // counts: at the target
const NEAR = 25;                // counts: a seat that stopped moving this close to the target is there (an end stop
                                // a few counts short of a target at the end of the travel - fully down)
const FIRST_SHARE = 0.92;       // the first pulse aims at this share of the way: short rather than past (a precise
                                // move; a coarse one - getting out - aims at the whole way)
const TOWARD_FRESH_MS = 3000;   // a precise move (getting in, toward the wheel) starts from a position this recent only
const COARSE_TOL = 25;          // counts (~1 cm): close enough for a coarse move (the exit position need not be exact)
const END_EXTRA = 1.15;         // a target at the end of the travel (fully down): the pulse that long longer - the
                                // seat's own end stop ends it, the "short of the target" of an end stop is avoided
const MAX_PULSES = 4;           // per axis and move
const MIN_PULSE_MS = 120;       // a motor needs about this long to move at all
const MAX_PULSE_MS = 8000;      // no pulse runs longer (the whole travel takes ~10 s)
const SETTLE_MS = 250;          // after STOP, before the position is read
const GUARD_MS = 50;            // how often a pulse checks Stop and parked (no request: local state)
const TEST_MS = 1000;           // the speed test's pulse per direction
const MOVED = 5;                // counts: less than this after a pulse is "did not move"
const WRONG_WAY = 12;           // counts the wrong way that end a move and drop the direction
const READ_TRIES = 4;           // a position read with the motor stopped is tried this often ...
const READ_PAUSE_MS = 1000;     // ... this far apart (the motor is stopped: waiting costs only time)
const BEGIN_TRIES = 3;          // the extended session asked this often while the link is busy ...
const BEGIN_PAUSE_MS = 1500;    // ... this far apart
const STOP_MS = 3000;           // a STOP's answer is waited for this long, and an unanswered STOP sent again
const STOP_SENDS = 3;           // up to this many times
const PULSE_ANSWER_MS = 300;    // a PLUS / MINUS answer is waited for this long only (the pulse is timed anyway)
const KEEPALIVE_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (b) => b.map((x) => hex(x)).join(' ');
const other = (a) => (a === 'plus' ? 'minus' : 'plus');

/** The writes, and the session they need. */
class SeatDrive {
    /** link: the DmeLink (its diag and available, once init() ran). */
    /** o (optional): { sleep(ms) } for the tests. */
    constructor(link, log, o) {
        this.link = link; this.log = log;
        this.wait = (o && o.sleep) || sleep;
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

    /**
     * One motor command: axis 'slv' | 'shv', action 'plus' | 'minus' | 'stop'. Resolves { ok, nrc, reason }.
     * A STOP waits long for its answer and is sent again unanswered; a PLUS / MINUS waits PULSE_ANSWER_MS once
     * (a pulse is timed from the command whether or not it is answered).
     */
    async motor(axis, action) {
        if (!Object.prototype.hasOwnProperty.call(MOTOR, axis) || !Object.prototype.hasOwnProperty.call(ACTION, action)) {
            throw new Error('not a seat command: ' + axis + ' ' + action);
        }
        if (!this.available) return { ok: false, reason: 'no diagnostic link' };
        const data = [0xD7, 0x08, MOTOR[axis], ACTION[action], PWM];
        this.log.info('seat: UDS -> FAS 2E ' + bytes(data) + ' (' + axis + ' ' + action + ')');
        const stop = action === 'stop';
        const tries = stop ? 5 : 2, sends = stop ? STOP_SENDS : 1, waitMs = stop ? STOP_MS : PULSE_ANSWER_MS;
        try {
            let r = null;
            for (let i = 0; i < sends; i++) {
                r = await this._send(0x2E, data, waitMs, tries, stop);
                if (r.ok || (r.nrc !== null && r.nrc !== undefined)) break;          // answered: taken or refused
                if (i + 1 < sends) this.log.warn('seat: ' + axis + ' ' + action + ' unanswered (' + r.reason + '): sent again');
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

    /**
     * Before a move: the extended session. A link that is busy (the transport turning requests away: right after the
     * engine was started or stopped, G30) is tried again BEGIN_TRIES times, BEGIN_PAUSE_MS apart; a refusal or no
     * answer from the module is not. Resolves { ok, reason }.
     */
    async begin() {
        if (!this.available) return { ok: false, reason: 'no diagnostic link' };
        let r = null;
        for (let i = 0; i < BEGIN_TRIES; i++) {
            if (i) { this.log.info('seat: the link was busy: the session asked again'); await this.wait(BEGIN_PAUSE_MS); }
            try { return await this._session(); } catch (e) { r = { ok: false, reason: String(e && e.message || e) }; }
            if (!/TEMPORARILY|BUSY/i.test(r.reason)) return r;
        }
        return r;
    }

    /** After a move (STOP already sent): tester present off and the default session (10 01). Never throws. */
    async end() {
        const was = this.extended;
        this.keep(false);
        if (!was || !this.available) return;
        this.log.info('seat: UDS -> FAS 10 01 (default session)');
        try { await this._send(0x10, [0x01], 3000, 4, true); } catch (e) { this.log.warn('seat: default session: ' + e); }
    }

    /**
     * Tester present (3E 00) every 2 s while on, with a short wait (a STOP queued behind it waits that long at most);
     * off: the module falls back to its default session by itself.
     */
    keep(on) {
        clearInterval(this._keep); this._keep = null;
        if (!on) { this.extended = false; return; }
        if (!this.extended) return;
        this._keep = setInterval(() => this.keepTick(), KEEPALIVE_MS / 2);
        if (this._keep.unref) this._keep.unref();
    }

    /**
     * One tester present (3E 00), only when nothing else went to the seat module for KEEPALIVE_MS (any request keeps
     * the session) and none is on its way: they used to pile up in the queue behind a slow request (G30 journal).
     */
    keepTick() {
        const diag = this.link && this.link.diag;
        if (!this.extended || this._ka || !diag) return false;
        const last = diag.lastAt && diag.lastAt[FAS];
        if (last && Date.now() - last < KEEPALIVE_MS) return false;
        this._ka = true;
        this._send(0x3E, [0x00], 500, 0).catch(() => {}).then(() => { this._ka = false; });
        return true;
    }

    /** STOP to both motors we drive, whatever happened before. */
    async stopAll() {
        await this.motor('slv', 'stop');
        await this.motor('shv', 'stop');
    }
}

/**
 * Moves toward Hall counters by timed pulses. probe: the SeatProbe (its learned directions and speeds); seatLink:
 * the reads; drive: the writes; guard(): true while a move may go on (armed, parked: main.js).
 */
class SeatMover {
    constructor(o) {
        this.probe = o.probe; this.seat = o.seatLink; this.drive = o.drive; this.log = o.log;
        this.guard = o.guard || (() => false);
        this.now = o.now || (() => Date.now());
        this.wait = o.sleep || sleep;
        this.busy = false; this.aborted = false; this.reason = null; this.axis = null;
        // what a running move is doing, for the page: { axis, start, now, target, action, pulse } or null
        this.progress = null;
        this.testing = false;           // the speed test runs
        this.tested = null;             // the last speed test: { ok, text } (shown on the page)
    }

    /** Stop what runs: a pulse sees it within GUARD_MS and sends STOP. */
    stop(reason) { if (this.busy) { this.aborted = true; this.reason = reason || 'stopped'; } }

    /**
     * The position with the motor stopped, and the seat's switches with it (one request: SeatLink.readBoth); tried
     * READ_TRIES times. { slv, shv, ... } or null; the switches kept for _switchHeld().
     */
    async _settled() {
        this._switches = null;
        for (let i = 0; i < READ_TRIES; i++) {
            if (i) await this.wait(READ_PAUSE_MS);
            const b = this.seat.readBoth ? await this.seat.readBoth() : null;
            if (b && b.ok) { this._switches = b.switches; return b.hall; }
            if (!b) { const h = await this.seat.read(DID.HALL); if (h.ok) return parseHall(h.data); }
        }
        return null;
    }

    /** A seat switch held, as the last check read it (null: not read). No request of its own. */
    async _switchHeld() {
        if (this._switches) return this._switches.pressed;
        if (this.seat.readBoth) return null;
        const s = await this.seat.read(DID.SWITCHES);
        return s.ok ? parseSwitches(s.data).pressed : null;
    }

    /**
     * One pulse: the motor on for ms from when its command was sent, then STOP. Resolves { why, ran }: why is
     * null when it ran its time, else why it was cut short (STOP sent at once).
     */
    async pulse(axis, action, ms) {
        const t0 = this.now();
        let w = null, why = null;
        const cmd = this.drive.motor(axis, action).then((r) => { w = r; }, (e) => { w = { ok: false, reason: String(e) }; });
        for (;;) {
            const left = ms - (this.now() - t0);
            if (left <= 0) break;
            if (this.aborted) { why = this.reason || 'stopped'; break; }
            if (!this.guard()) { why = 'not allowed now'; break; }
            if (w && !w.ok && w.nrc !== null && w.nrc !== undefined) { why = 'command refused: ' + w.reason; break; }
            await this.wait(Math.min(GUARD_MS, left));
        }
        await cmd;                                       // (its answer is waited for PULSE_ANSWER_MS at most)
        const ran = this.now() - t0;
        await this.drive.motor(axis, 'stop');
        if (!why && w && !w.ok && w.nrc !== null && w.nrc !== undefined) why = 'command refused: ' + w.reason;
        return { why: why, ran: ran };
    }

    /** The action that moves the axis's counter up (true) or down, from the learned direction; null unknown. */
    _actionFor(axis, up) {
        const r = this.probe.rises[axis];
        if (r !== 'plus' && r !== 'minus') return null;
        return up ? r : other(r);
    }

    /**
     * One axis to a counter, by timed pulses (Fabian, 15.11.2026): from the LAST position read (any age: the
     * background watch keeps it fresh while the car runs; read first only when there is none), a pulse worked out by
     * the speed, then the position read to check, and corrected.
     * opts.coarse (getting out): within COARSE_TOL is there, the first pulse aims at the whole way, and the move is
     * ONE WAY - corrections only go on the way the first pulse went (back / down), never toward the wheel or up:
     * past the target is accepted. And a check that cannot be read counts as there, its position worked out from the
     * speed (the next move checks it).
     * A precise move (getting in) starts from the last position only when it is under TOWARD_FRESH_MS old, else it
     * reads first: it goes toward the wheel, and a seat moved since the last read would be pushed past its target.
     * Resolves true at the target, false otherwise (this.reason says why).
     */
    async moveAxis(axis, target, opts) {
        if (!this._actionFor(axis, true)) { this.reason = 'direction not learned'; return false; }
        if (!this.guard()) { this.reason = 'not allowed now'; return false; }
        const coarse = !!(opts && opts.coarse), tol = coarse ? COARSE_TOL : TOLERANCE;
        const ends = this.probe.travel && this.probe.travel[axis];
        const toEnd = !!(ends && (target <= ends[0] + 2 || target >= ends[1] - 2));
        // getting out (one way, back / down): the last position read, whatever its age. Toward the wheel (getting in)
        // only a recent one (the background watch): a seat moved since - the M1 button pressed after getting in -
        // would otherwise be pushed toward the wheel by the whole distance; else one read first
        const first = (coarse ? this.probe.hall : this.probe.fresh && this.probe.fresh(TOWARD_FRESH_MS)) || await this._settled();
        let p = first && first[axis];
        if (p === null || p === undefined) { this.reason = 'position not read'; return false; }
        this.axis = axis;
        this.progress = { axis: axis, start: p, now: p, target: target, action: null, pulse: 0 };
        this.log.info('seat: ' + axis + ' ' + p + ' -> ' + target + (coarse ? ' (coarse, one way)' : ''));
        const firstUp = target > p;
        try {
            for (let i = 0; i < MAX_PULSES; i++) {
                const d = target - p;
                if (Math.abs(d) <= tol) return true;
                // one way (getting out): past the target is there, nothing goes back toward the wheel or up
                if (coarse && i > 0 && (d > 0) !== firstUp) return true;
                const up = d > 0, action = this._actionFor(axis, up);
                const v = this.probe.speed(axis, action);
                if (!v) { this.reason = 'measure the seat speed first (Seat module)'; return false; }
                const share = i === 0 && !coarse ? FIRST_SHARE : 1;
                const ms = Math.round(Math.max(MIN_PULSE_MS, Math.min(MAX_PULSE_MS, Math.abs(d) * share / v * (toEnd ? END_EXTRA : 1))));
                this.progress.action = action; this.progress.pulse = i + 1;
                this.log.info('seat: ' + axis + ' pulse ' + (i + 1) + ' ' + action + ' ' + ms + ' ms for ' + Math.abs(d) + ' counts');
                const r = await this.pulse(axis, action, ms);
                if (r.why) { this.reason = r.why; return false; }
                await this.wait(SETTLE_MS);
                const h = await this._settled();
                let q = h && h[axis];
                if ((q === null || q === undefined) && coarse) {
                    // getting out, the check not read: the pulse ran its time - there, at the position the speed gives
                    q = Math.round(p + (up ? 1 : -1) * v * r.ran);
                    if (ends) q = Math.max(ends[0], Math.min(ends[1], q));
                    const est = Object.assign({}, this.probe.hall || {}); est[axis] = q;
                    if (this.probe.seen) this.probe.seen(est);
                    this.log.warn('seat: ' + axis + ' check not read: taken as ' + q + ' from the speed');
                    return true;
                }
                if (q === null || q === undefined) { this.reason = 'position not read'; return false; }
                if (this.probe.seen) this.probe.seen(h);
                this.progress.now = q;
                const moved = q - p;
                if (up ? moved < -WRONG_WAY : moved > WRONG_WAY) {
                    this.probe.forgetDirection(axis);
                    this.reason = 'went the wrong way: the direction is learned again'; return false;
                }
                if (Math.abs(target - q) <= tol) return true;
                if (Math.abs(moved) < MOVED) {
                    if (Math.abs(target - q) <= NEAR) return true;                       // an end stop at the target
                    this.reason = 'the seat did not move'; return false;
                }
                this.probe.learnSpeed(axis, action, Math.abs(moved) / r.ran);
                if (await this._switchHeld()) { this.reason = 'a seat switch was touched'; return false; }
                p = q;
            }
            if (Math.abs(target - p) <= NEAR) return true;
            this.reason = 'not there after ' + MAX_PULSES + ' pulses'; return false;
        } finally {
            this.axis = null; this.progress = null;
        }
    }

    /**
     * Pulses on several axes at once: each motor's command sent (one after the other in the link's queue), each
     * stopped at its own time; Stop, not parked or a refusal stop them all at once. Resolves { why, unsupported }:
     * unsupported when a later motor was refused while an earlier one ran (two motors together not taken).
     * Each entry gets ran (ms its motor ran).
     */
    async pulses(list) {
        const runs = list.map((e) => ({ e: e, w: null, cmd: null, start: 0, stopped: false }));
        let why = null, unsupported = false;
        for (const r of runs) {
            r.start = this.now();
            r.cmd = this.drive.motor(r.e.axis, r.e.action).then((res) => { r.w = res; }, (err) => { r.w = { ok: false, reason: String(err) }; });
        }
        const refused = (r) => r.w && !r.w.ok && r.w.nrc !== null && r.w.nrc !== undefined;
        const stopIt = async (r) => {
            await r.cmd;                                 // (its answer is waited for PULSE_ANSWER_MS at most)
            r.e.ran = this.now() - r.start;
            await this.drive.motor(r.e.axis, 'stop');
            r.stopped = true;
        };
        for (;;) {
            const ref = runs.filter(refused)[0];
            if (ref) {
                if (ref !== runs[0] && runs[0].w && runs[0].w.ok) unsupported = true;
                else why = 'command refused: ' + ref.w.reason;
                break;
            }
            if (this.aborted) { why = this.reason || 'stopped'; break; }
            if (!this.guard()) { why = 'not allowed now'; break; }
            for (const r of runs) {
                if (!r.stopped && this.now() - r.start >= r.e.ms) await stopIt(r);
            }
            const going = runs.filter((r) => !r.stopped);
            if (!going.length) break;
            const left = Math.min.apply(null, going.map((r) => r.e.ms - (this.now() - r.start)));
            await this.wait(Math.max(1, Math.min(GUARD_MS, left)));
        }
        for (const r of runs) if (!r.stopped) await stopIt(r);       // whatever ended it: every motor stopped
        return { why: why, unsupported: unsupported };
    }

    /**
     * Several axes to their counters at once, by timed pulses - the rules of moveAxis (the last position; coarse =
     * one way, close enough, a check not read worked out from the speed; precise = from a recent position only).
     * Resolves true, false (this.reason says why) or 'unsupported' (the module would not run two motors together).
     */
    async moveTogether(steps, opts) {
        const coarse = !!(opts && opts.coarse), tol = coarse ? COARSE_TOL : TOLERANCE;
        const axes = steps.map((s) => s[0]), target = {};
        steps.forEach((s) => { target[s[0]] = s[1]; });
        if (axes.some((a) => !this._actionFor(a, true))) { this.reason = 'direction not learned'; return false; }
        if (!this.guard()) { this.reason = 'not allowed now'; return false; }
        const first = (coarse ? this.probe.hall : this.probe.fresh && this.probe.fresh(TOWARD_FRESH_MS)) || await this._settled();
        const p = {}, firstUp = {}, ends = {}, toEnd = {};
        for (const a of axes) {
            p[a] = first && first[a];
            if (p[a] === null || p[a] === undefined) { this.reason = 'position not read'; return false; }
            firstUp[a] = target[a] > p[a];
            ends[a] = this.probe.travel && this.probe.travel[a];
            toEnd[a] = !!(ends[a] && (target[a] <= ends[a][0] + 2 || target[a] >= ends[a][1] - 2));
        }
        this.log.info('seat: together ' + axes.map((a) => a + ' ' + p[a] + ' -> ' + target[a]).join(', ') + (coarse ? ' (coarse, one way)' : ''));
        this.progress = { axis: axes[0], start: p[axes[0]], now: p[axes[0]], target: target[axes[0]], action: null, pulse: 0 };
        try {
            for (let i = 0; i < MAX_PULSES; i++) {
                const list = [];
                for (const a of axes) {
                    const d = target[a] - p[a];
                    if (Math.abs(d) <= tol) continue;
                    if (coarse && i > 0 && (d > 0) !== firstUp[a]) continue;           // one way: past is there
                    const up = d > 0, action = this._actionFor(a, up), v = this.probe.speed(a, action);
                    if (!v) { this.reason = 'measure the seat speed first (Seat module)'; return false; }
                    const share = i === 0 && !coarse ? FIRST_SHARE : 1;
                    const ms = Math.round(Math.max(MIN_PULSE_MS, Math.min(MAX_PULSE_MS, Math.abs(d) * share / v * (toEnd[a] ? END_EXTRA : 1))));
                    list.push({ axis: a, action: action, ms: ms, up: up, v: v, ran: 0 });
                }
                if (!list.length) return true;
                const shown = list[0];
                this.progress.axis = shown.axis; this.progress.target = target[shown.axis]; this.progress.now = p[shown.axis];
                this.progress.action = shown.action; this.progress.pulse = i + 1;
                this.log.info('seat: pulse ' + (i + 1) + ' ' + list.map((e) => e.axis + ' ' + e.action + ' ' + e.ms + ' ms').join(', '));
                const r = await this.pulses(list);
                if (r.unsupported) return 'unsupported';
                if (r.why) { this.reason = r.why; return false; }
                await this.wait(SETTLE_MS);
                const h = await this._settled();
                if (!h) {
                    if (!coarse) { this.reason = 'position not read'; return false; }
                    // getting out, the check not read: each pulse ran its time - there, where the speed puts it
                    const est = Object.assign({}, this.probe.hall || {});
                    list.forEach((e) => {
                        let q = Math.round(p[e.axis] + (e.up ? 1 : -1) * e.v * e.ran);
                        if (ends[e.axis]) q = Math.max(ends[e.axis][0], Math.min(ends[e.axis][1], q));
                        est[e.axis] = q;
                    });
                    if (this.probe.seen) this.probe.seen(est);
                    this.log.warn('seat: check not read: taken as there from the speed');
                    return true;
                }
                if (this.probe.seen) this.probe.seen(h);
                for (const e of list) {
                    const q = h[e.axis], moved = q - p[e.axis];
                    if (e.up ? moved < -WRONG_WAY : moved > WRONG_WAY) {
                        this.probe.forgetDirection(e.axis);
                        this.reason = 'went the wrong way: the direction is learned again'; return false;
                    }
                    if (Math.abs(target[e.axis] - q) > tol && Math.abs(moved) < MOVED) {
                        // stopped short of its target: at the end of its travel (close) it is there, else it did not move
                        if (Math.abs(target[e.axis] - q) > NEAR) { this.reason = 'the seat did not move'; return false; }
                        target[e.axis] = q;
                    }
                    if (Math.abs(moved) >= MOVED && e.ran > 0) this.probe.learnSpeed(e.axis, e.action, Math.abs(moved) / e.ran);
                }
                for (const a of axes) if (h[a] !== null && h[a] !== undefined) p[a] = h[a];
                this.progress.now = p[shown.axis];
                if (await this._switchHeld()) { this.reason = 'a seat switch was touched'; return false; }
            }
            if (axes.every((a) => Math.abs(target[a] - p[a]) <= NEAR)) return true;
            this.reason = 'not there after ' + MAX_PULSES + ' pulses'; return false;
        } finally {
            this.progress = null;
        }
    }

    /** Runs fn in the extended session, one at a time; the default session after, whatever happened. */
    async _session(fn) {
        if (this.busy) { this.reason = 'already moving'; return false; }
        this.aborted = false; this.reason = null;
        if (!this.guard()) { this.reason = 'not allowed now'; return false; }
        this.busy = true;
        try {
            const s = await this.drive.begin();
            if (!s.ok) { this.reason = 'extended session: ' + s.reason; return false; }
            return await fn();
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

    /**
     * Several axes: [[axis, counter], ...]. Both at once (as BMW's own memory does: no wait between the axes, the
     * move as long as its longest axis) while the module takes two motors together; one after the other once it
     * refused that (this.parallel false). Resolves true when all arrived.
     */
    run(steps, opts) {
        return this._session(async () => {
            if (steps.length > 1 && this.parallel !== false) {
                const r = await this.moveTogether(steps, opts);
                if (r !== 'unsupported') {
                    if (r) this.parallel = true;
                    this.log[r ? 'info' : 'warn']('seat: ' + steps.map((s) => s[0]).join(' + ') + (r ? ' at ' + steps.map((s) => s[1]).join(' / ') : ' stopped: ' + this.reason));
                    return r;
                }
                this.parallel = false;
                if (this.probe.hall) this.probe.hallAt = 0;          // the first motor ran a moment: read before going on
                this.log.warn('seat: two motors at once not taken: one axis at a time from now');
            }
            for (const st of steps) {
                if (!(await this.moveAxis(st[0], st[1], opts))) {
                    this.log.warn('seat: ' + st[0] + ' stopped: ' + this.reason);
                    return false;
                }
                this.log.info('seat: ' + st[0] + ' at ' + st[1]);
            }
            return true;
        });
    }

    /**
     * The speed test: each axis MINUS (back / down) for TEST_MS, then PLUS for TEST_MS (so it ends about where it
     * began), the position read only with the motor stopped. Keeps the speeds with the probe and checks (or, when
     * not learned yet, learns) which way the counters run. Resolves true when both axes were measured.
     */
    measureSpeed() {
        this.testing = true; this.tested = null;
        const out = {};
        return this._session(async () => {
            for (const axis of ['slv', 'shv']) {
                const a = await this._settled();
                const p0 = a && a[axis];
                if (p0 === null || p0 === undefined) { this.reason = 'position not read'; return false; }
                const res = {};
                let from = p0;
                for (const action of ['minus', 'plus']) {
                    this.progress = { axis: axis, start: from, now: from, target: from, action: action, pulse: 0 };
                    const r = await this.pulse(axis, action, TEST_MS);
                    if (r.why) { this.reason = r.why; return false; }
                    await this.wait(SETTLE_MS);
                    const b = await this._settled();
                    const to = b && b[axis];
                    if (to === null || to === undefined) { this.reason = 'position not read'; return false; }
                    if (await this._switchHeld()) { this.reason = 'a seat switch was touched'; return false; }
                    if (Math.abs(to - from) < MOVED) { this.reason = 'the seat did not move (' + axis + ' ' + action + ')'; return false; }
                    // which way PLUS / MINUS move the counter: learned here when unknown, else it must agree
                    const rises = (to > from) === (action === 'plus') ? 'plus' : 'minus';
                    const known = this.probe.rises[axis];
                    if (known && known !== rises) {
                        this.probe.forgetDirection(axis);
                        this.reason = axis + ' went the other way than learned: the direction is learned again';
                        return false;
                    }
                    if (!known) this.probe.setDirection(axis, rises);
                    res[action] = Math.abs(to - from) / r.ran;
                    this.probe.setSpeed(axis, action, res[action]);
                    this.log.info('seat: speed ' + axis + ' ' + action + ' ' + Math.round(res[action] * 1000) + ' counts/s');
                    from = to;
                }
                out[axis] = res;
            }
            return true;
        }).then((ok) => {
            this.testing = false; this.progress = null;
            this.tested = ok ? { ok: true, speeds: out } : { ok: false, text: this.reason };
            return ok;
        });
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

    /**
     * The driver's seat to target (fractions; back is not moved). Fore / aft back first, then height.
     * opts.coarse: close enough is there (getting out).
     */
    async goTo(seat, target, opts) {
        if (seat !== 'driver') return false;
        // the last position read, whatever its age (a read only when there is none)
        if (!this.probe.hall) await this.probe.tick();
        const now = this.status().seats.driver.pos;
        if (now.fore === null || now.height === null) { this.log.warn('seat: no position or direction yet (Seat module)'); return false; }
        const fore = target.fore === undefined || target.fore === null ? null : this.probe.countFor('slv', target.fore);
        const height = target.height === undefined || target.height === null ? null : this.probe.countFor('shv', target.height);
        const steps = [];
        // going back (getting out): back first, then down; coming forward (getting in): up first, then forward
        const back = target.fore !== null && target.fore !== undefined && target.fore >= now.fore;
        if (back) { if (fore !== null) steps.push(['slv', fore]); if (height !== null) steps.push(['shv', height]); }
        else { if (height !== null) steps.push(['shv', height]); if (fore !== null) steps.push(['slv', fore]); }
        // (no read after the move: its checks keep the position; one right after 10 01 went unanswered on the G30)
        return this.mover.run(steps, opts);
    }

    stop() { this.mover.stop('stopped'); }
    jog() { /* hold-to-move from the screen: not offered */ }
    close() { this.mover.stop('closing'); }
}

module.exports = { SeatDrive, SeatMover, RealBackend, MOTOR, ACTION, PWM, TOLERANCE, COARSE_TOL, NEAR, TEST_MS, MAX_PULSES };
