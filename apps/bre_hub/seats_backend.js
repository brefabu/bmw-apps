'use strict';
/**
 * seats_backend.js - seat backends and the Easy Entry state machine (docs/07).
 *
 * A backend is the only thing that may move a seat. Every backend has the same shape, so the
 * Seats page and Easy Entry never change when the backend does:
 *
 *   status()                 -> { mode, connected, seats: { driver: Seat, passenger: Seat } }
 *                               Seat = { pos: { fore, height, back } (0..1), moving: bool, job: string|null }
 *   jog(seat, axis, dir)     hold-to-move one axis (+1 / -1); the caller repeats it every <= 300 ms,
 *                            the move stops on its own when the repeats stop ("dead man")
 *   goTo(seat, target)       all axes to a stored position; resolves true when there, false when stopped
 *   stop(seat)               stop at once
 *
 * Backends:
 *   'demo'   simulated seats (this file). Touches nothing in the car.
 *   'armed'  the real driver's seat: seat_drive.js's RealBackend, through the seat module's own job (2E D708),
 *            from the app (no root tool). main.js picks the backend by the "easyEntry" setting. See docs/07.
 * A backend may have refresh() (a fresh position before a move is worked out).
 */
const fs = require('fs');
const path = require('path');

const AXES = ['fore', 'height', 'back'];
const SPEED = 0.22;             // demo: share of the full travel per second (a real seat: ~10 s end to end)
const MOVE_LIMIT_MS = 8000;     // every move ends after this, whatever happens
const JOG_HOLD_MS = 350;        // a jog stops when it is not repeated within this
const TICK_MS = 50;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const DEMO = 'driver', REAL = 'driver.real';     // where the demo's and the real seat's positions are kept
const REFRESH_MS = 12000;       // a backend's fresh position read: given up after this (the position then counts as unknown)

/** p (a promise or a value), settled within ms whatever it does; never rejects. */
function withTimeout(p, ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        Promise.resolve(p).then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); });
    });
}

/* ------------------------------------------------------------------ demo backend */

class DemoSeat {
    constructor(pos) {
        this.pos = Object.assign({ fore: 0.35, height: 0.5, back: 0.3 }, pos || {});
        this.move = null;       // { target, until, resolve } or { axis, dir, holdUntil, until }
    }
    snapshot() {
        return { pos: Object.assign({}, this.pos), moving: !!this.move, job: this.move ? (this.move.target ? 'goTo' : 'jog') : null };
    }
    finish(ok) {
        const m = this.move;
        this.move = null;
        if (m && m.resolve) m.resolve(ok);
    }
    step(dt, now) {
        const m = this.move;
        if (!m) return;
        if (now > m.until) return this.finish(false);
        const d = SPEED * dt;
        if (m.target) {
            let done = true;
            AXES.forEach((a) => {
                const want = clamp01(m.target[a] === undefined ? this.pos[a] : m.target[a]), have = this.pos[a];
                if (Math.abs(want - have) <= d) this.pos[a] = want;
                else { this.pos[a] = have + (want > have ? d : -d); done = false; }
            });
            if (done) this.finish(true);
        } else {
            if (now > m.holdUntil) return this.finish(false);
            const before = this.pos[m.axis];
            this.pos[m.axis] = clamp01(before + m.dir * d);
            if (this.pos[m.axis] === before) this.finish(false);          // end stop: no progress
        }
    }
}

class DemoBackend {
    constructor(log) {
        this.log = log;
        this.mode = 'demo';
        this.seats = { driver: new DemoSeat(), passenger: new DemoSeat({ fore: 0.4 }) };
        this.last = Date.now();
        this.timer = setInterval(() => {
            const now = Date.now(), dt = Math.min(0.2, (now - this.last) / 1000);
            this.last = now;
            Object.keys(this.seats).forEach((k) => this.seats[k].step(dt, now));
        }, TICK_MS);
    }
    status() {
        return { mode: this.mode, connected: true,
            seats: { driver: this.seats.driver.snapshot(), passenger: this.seats.passenger.snapshot() } };
    }
    jog(seat, axis, dir) {
        const s = this.seats[seat];
        if (!s || AXES.indexOf(axis) < 0) return;
        const now = Date.now();
        if (s.move && s.move.axis === axis && s.move.dir === dir) { s.move.holdUntil = now + JOG_HOLD_MS; return; }
        s.finish(false);
        s.move = { axis, dir: dir > 0 ? 1 : -1, holdUntil: now + JOG_HOLD_MS, until: now + MOVE_LIMIT_MS };
    }
    goTo(seat, target) {
        const s = this.seats[seat];
        if (!s) return Promise.resolve(false);
        s.finish(false);
        return new Promise((resolve) => {
            s.move = { target: Object.assign({}, target), until: Date.now() + MOVE_LIMIT_MS, resolve };
        });
    }
    stop(seat) {
        const s = this.seats[seat];
        if (s) s.finish(false);
    }
    close() { clearInterval(this.timer); }
}

/* ------------------------------------------------------------------ saved positions */

/** The positions the person saved, in the app's data folder (kept across restarts). No history is kept. */
class Positions {
    constructor(dataDir, log) {
        this.file = path.join(dataDir || '.', 'bre_seats.json');
        this.log = log;
        this.data = { driver: { drive: null, exit: null }, passenger: { drive: null, room: null } };
        try { this.data = Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* first start */ }
    }
    get(seat, name) { return this.data[seat] ? this.data[seat][name] : null; }
    set(seat, name, pos) {
        if (!this.data[seat]) this.data[seat] = {};
        this.data[seat][name] = { fore: pos.fore, height: pos.height, back: pos.back };
        this._write();
    }
    /** A yes / no kept with the positions (the driver's seat let out, waiting for the car to start). */
    flag(seat, name) { return !!(this.data[seat] && this.data[seat].flags && this.data[seat].flags[name]); }
    setFlag(seat, name, on) {
        if (!this.data[seat]) this.data[seat] = {};
        const f = this.data[seat].flags || (this.data[seat].flags = {});
        if (!!f[name] === !!on) return;
        f[name] = !!on;
        this._write();
    }
    _write() {
        try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (e) { if (this.log) this.log.warn('seats: save failed ' + e); }
    }
}

/* ------------------------------------------------------------------ Easy Entry */

/**
 * Seat Easy Access: where the driver's seat goes to let the driver out. Back to `offset` of the rail's travel
 * (0 = fully forward, 1 = fully back; never forward of where it is) and fully down; the backrest stays.
 */
function exitPosition(pos, offset) {
    return { fore: Math.max(pos.fore, clamp01(offset)), height: 0, back: pos.back };
}

/**
 * The driver's Seat Easy Access (docs/07):
 *   IDLE --(the car switched off, parked)--> MOVING_OUT --> OUT --(the car started, parked)--> MOVING_IN --> IDLE
 *   any state --(moving, a manual move, a failed move)--> STOPPED, which goes back to IDLE on the next start
 *   (or reset()).
 * Out is exitPosition(where the seat is, this.offset); in is position 1 when saved (savePosition), else where
 * the seat was. The real triggers are
 * carStopped() / carStarted() (main.js, from the vehicle state); onCar() is the page's demo (door and ignition).
 * OUT is kept with the positions, so a restart of the app between switching off and starting still brings the
 * seat back.
 * The demo and the real seat keep their positions and their OUT apart ('driver' / 'driver.real', by the backend's
 * mode): nothing the demo saved ever moves the real seat.
 */
class EasyEntry {
    constructor(backend, positions, log) {
        this.backend = backend; this.positions = positions; this.log = log;
        this.offset = 0.75;                        // how far back the seat goes (setOffset)
        // OUT kept from before (a restart between switching off and starting): which seat it belongs to
        const kept = (k) => positions && positions.flag && positions.flag(k, 'out') && positions.get(k, 'drive');
        this.outKey = kept(REAL) ? REAL : kept(DEMO) ? DEMO : null;
        this.state = this.outKey ? 'OUT' : 'IDLE';
        this.events = [];                          // the last few events, shown on the page; never written to disk
        this.car = { doorOpen: false, ignition: true, parked: true };
    }
    /** Where this seat's positions are kept: the real seat's apart from the demo's. */
    _key() { return this.backend && this.backend.mode === 'armed' ? REAL : DEMO; }
    _set(state) {
        this.state = state;
        if (!this.positions || !this.positions.setFlag) return;
        if (state === 'OUT') { this.outKey = this._key(); this.positions.setFlag(this.outKey, 'out', true); }
        else { this.outKey = null; this.positions.setFlag(REAL, 'out', false); this.positions.setFlag(DEMO, 'out', false); }
    }
    /** The car was switched off (the vehicle state left drive-ready), or Try: get out: the seat out of the way. */
    carStopped(mode, parked) {
        if (!this.enabled(mode) || this.state !== 'IDLE') return false;
        if (!parked) { this.note('ee.notParked'); return false; }
        this.goOut();
        return true;
    }
    /** The car was started (drive-ready), or Try: get in: back to the driving position if the seat was let out. */
    carStarted(mode, parked) {
        if (this.state === 'STOPPED') { this._set('IDLE'); this.note('ee.ready'); return false; }
        if (!this.enabled(mode) || this.state !== 'OUT') return false;
        // let out by the demo: the real seat was never moved, so it is not brought back from anywhere
        if (this.outKey && this.outKey !== this._key()) { this.note('ee.otherMode'); return false; }
        if (!parked) { this.note('ee.notParked'); return false; }
        this.goIn();
        return true;
    }
    /** key: a bre_text key (ee.*), shown translated on the page. */
    note(key) {
        this.events.unshift({ t: Date.now(), key: key });
        if (this.events.length > 5) this.events.pop();
        if (this.log) this.log.info('easy entry: ' + key);
    }
    enabled(mode) { return mode === 'demo' || mode === 'armed'; }
    /** Feed what the car (or the demo) says; mode is the app's easyEntry setting. */
    onCar(input, mode) {
        const was = this.car;
        this.car = Object.assign({}, was, input);
        const c = this.car;
        if (!c.parked && (this.state === 'MOVING_OUT' || this.state === 'MOVING_IN')) {
            this.backend.stop('driver');
            this._set('STOPPED'); this.note('ee.stoppedMoved');
            return;
        }
        if (!this.enabled(mode)) return;
        if (this.state === 'IDLE' && c.doorOpen && !was.doorOpen && !c.ignition && c.parked) this.goOut();
        else if (this.state === 'OUT' && !c.doorOpen && c.ignition && (was.doorOpen || !was.ignition)) this.goIn();
        else if (this.state === 'STOPPED' && c.ignition && !was.ignition) { this._set('IDLE'); this.note('ee.ready'); }
    }
    /** percent: 0..100 of the rail's travel (the "seatOffset" setting). */
    setOffset(percent) {
        const v = Number(percent);
        if (isFinite(v)) this.offset = clamp01(v / 100);
    }
    /** STOPPED back to IDLE (the menu's "Ready again"). */
    reset() {
        if (this.state === 'STOPPED') { this._set('IDLE'); this.note('ee.ready'); }
    }
    goOut() {
        this.state = 'MOVING_OUT'; this.note('ee.movingOut');
        // a fresh position first (the real seat: read from its module, at most REFRESH_MS), then where the seat is
        // now is the driving position to come back to
        return withTimeout(this.backend.refresh ? this.backend.refresh() : null, REFRESH_MS).then(() => {
            if (this.state !== 'MOVING_OUT') return null;
            const now = this.backend.status().seats.driver.pos;
            if (!isFinite(now.fore) || !isFinite(now.height) || now.fore === null || now.height === null) {
                this._set('IDLE'); this.note('ee.noPosition');
                return null;
            }
            this.positions.set(this._key(), 'drive', now);
            return this.backend.goTo('driver', exitPosition(now, this.offset)).then((ok) => {
                if (this.state !== 'MOVING_OUT') return;
                this._set(ok ? 'OUT' : 'STOPPED'); this.note(ok ? 'ee.atExit' : 'ee.notFinished');
            });
        });
    }
    /**
     * Position 1: the seat as it is now (a fresh read first), where it comes back to when the car starts - in
     * place of where it was when the car was switched off. Resolves true when saved.
     */
    savePosition() {
        return withTimeout(this.backend.refresh ? this.backend.refresh() : null, REFRESH_MS).then(() => {
            const now = this.backend.status().seats.driver.pos;
            if (!isFinite(now.fore) || !isFinite(now.height) || now.fore === null || now.height === null) {
                this.note('ee.noPosition');
                return false;
            }
            this.positions.set(this._key(), 'mem1', now);
            this.note('ee.saved');
            return true;
        });
    }
    /** Position 1 saved. */
    hasPosition() { return !!this.positions.get(this._key(), 'mem1'); }
    goIn() {
        // position 1 when saved, else where the seat was when the car was switched off
        const key = this._key();
        const drive = this.positions.get(key, 'mem1') || this.positions.get(key, 'drive');
        if (!drive) { this._set('IDLE'); this.note('ee.noReturn'); return Promise.resolve(); }
        this.state = 'MOVING_IN'; this.note('ee.movingIn');
        return Promise.resolve(this.backend.goTo('driver', drive)).then((ok) => {
            if (this.state !== 'MOVING_IN') return;
            this._set(ok ? 'IDLE' : 'STOPPED'); this.note(ok ? 'ee.atDrive' : 'ee.notFinished');
        });
    }
    /** A manual move or Stop on the page cancels whatever Easy Entry was doing. */
    manual() {
        if (this.state === 'MOVING_OUT' || this.state === 'MOVING_IN') {
            this.backend.stop('driver'); this._set('STOPPED'); this.note('ee.manual');
        }
    }
}

/** The demo backend ('armed', the real seat, is seat_drive.js's RealBackend: main.js picks it by the setting). */
function createBackend(mode, log) {
    return new DemoBackend(log);
}

module.exports = { AXES, createBackend, Positions, EasyEntry, DemoBackend, exitPosition };
