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
 *   'demo'  simulated seats (this file). Touches nothing in the car. The only one in the template.
 *   next:   'comfort' (a client for IterioDev's separately installed Comfort service, personal use only)
 *           or 'bre' (our own root tool bre-comfort, written from the SGBD job tables). See docs/07.
 */
const fs = require('fs');
const path = require('path');

const AXES = ['fore', 'height', 'back'];
const SPEED = 0.22;             // demo: share of the full travel per second (a real seat: ~10 s end to end)
const MOVE_LIMIT_MS = 8000;     // every move ends after this, whatever happens
const JOG_HOLD_MS = 350;        // a jog stops when it is not repeated within this
const TICK_MS = 50;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

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
 *   IDLE --(door open, ignition off, parked)--> MOVING_OUT --> OUT --(door shut, ignition on)--> MOVING_IN --> IDLE
 *   any state --(moving, a manual move, a failed move)--> STOPPED, which goes back to IDLE on the next ignition on
 *   (or reset()).
 * Out is exitPosition(where the seat is, this.offset); in is where the seat was. Inputs come from the car
 * (onCar) or, in the demo, from the page's menu.
 */
class EasyEntry {
    constructor(backend, positions, log) {
        this.backend = backend; this.positions = positions; this.log = log;
        this.offset = 0.75;                        // how far back the seat goes (setOffset)
        this.state = 'IDLE';
        this.events = [];                          // the last few events, shown on the page; never written to disk
        this.car = { doorOpen: false, ignition: true, parked: true };
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
            this.state = 'STOPPED'; this.note('ee.stoppedMoved');
            return;
        }
        if (!this.enabled(mode)) return;
        if (this.state === 'IDLE' && c.doorOpen && !was.doorOpen && !c.ignition && c.parked) this.goOut();
        else if (this.state === 'OUT' && !c.doorOpen && c.ignition && (was.doorOpen || !was.ignition)) this.goIn();
        else if (this.state === 'STOPPED' && c.ignition && !was.ignition) { this.state = 'IDLE'; this.note('ee.ready'); }
    }
    /** percent: 0..100 of the rail's travel (the "seatOffset" setting). */
    setOffset(percent) {
        const v = Number(percent);
        if (isFinite(v)) this.offset = clamp01(v / 100);
    }
    /** STOPPED back to IDLE (the menu's "Ready again"). */
    reset() {
        if (this.state === 'STOPPED') { this.state = 'IDLE'; this.note('ee.ready'); }
    }
    goOut() {
        // the driving position to come back to is where the seat is now
        const now = this.backend.status().seats.driver.pos;
        this.positions.set('driver', 'drive', now);
        const exit = exitPosition(now, this.offset);
        this.state = 'MOVING_OUT'; this.note('ee.movingOut');
        this.backend.goTo('driver', exit).then((ok) => {
            if (this.state !== 'MOVING_OUT') return;
            this.state = ok ? 'OUT' : 'STOPPED'; this.note(ok ? 'ee.atExit' : 'ee.notFinished');
        });
    }
    goIn() {
        const drive = this.positions.get('driver', 'drive');
        if (!drive) { this.state = 'IDLE'; return; }
        this.state = 'MOVING_IN'; this.note('ee.movingIn');
        this.backend.goTo('driver', drive).then((ok) => {
            if (this.state !== 'MOVING_IN') return;
            this.state = ok ? 'IDLE' : 'STOPPED'; this.note(ok ? 'ee.atDrive' : 'ee.notFinished');
        });
    }
    /** A manual move or Stop on the page cancels whatever Easy Entry was doing. */
    manual() {
        if (this.state === 'MOVING_OUT' || this.state === 'MOVING_IN') {
            this.backend.stop('driver'); this.state = 'STOPPED'; this.note('ee.manual');
        }
    }
}

/** The backend for a mode: only 'demo' exists yet; 'armed' falls back to demo and says so. */
function createBackend(mode, log) {
    if (mode === 'armed' && log) log.warn('seats: no real backend yet (docs/07), using the demo');
    return new DemoBackend(log);
}

module.exports = { AXES, createBackend, Positions, EasyEntry, DemoBackend, exitPosition };
