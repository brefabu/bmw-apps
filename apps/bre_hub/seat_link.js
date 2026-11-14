'use strict';
/**
 * seat_link.js - the seat probe (docs/07, step 2): a READ ONLY look at the driver's seat module (FAS, diagnostic
 * address 0x6D) over the head unit's diagnostic transport (kit/diag.js, the Diag the DME link opened).
 *
 * What may leave, and nothing else: 22 <DID> to 0x6D, the DIDs in READS, in the module's default session.
 * No session change, no write (2E), no actuator (2F), no routine (31). A seat that moves is not this file.
 *
 *   22 D700  CONFIG_HW            per axis: 0 no motor, 1 motor, 2 motor and Hall sensor (a position to read)
 *   22 D702  HALLZAEHLER          per axis the Hall counter, u16 big-endian, 8192..57344
 *   22 D704  INITIALISIERUNG_SITZ byte 0: 0 not initialised, 1 initialised, 255 not right; per axis normalised + / -
 *   22 D708  MOTOR                per axis: 0 off, 1 plus (fore / up), 2 minus (back / down), 3 not fitted
 *   22 D712  SCHALTER_SV          the seat's own switches, per axis + / -: 0 not pressed, 1 pressed, 2 not fitted
 * Layouts from the SGBD FAS_G11 (Sitzmodul Fahrer, the G11 platform), public reference
 * https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/FAS_G11/ (SG_FUNKTIONEN). The G30 is on that platform; the
 * probe is how we find out that its module answers the same.
 *
 * The travel: the lowest and highest counter seen per axis (moving the seat end to end with its own switches
 * measures it), and which way each counter runs (learned while it moves, see AXES), kept in bre_seat_travel.json
 * in the app's data folder. Nothing else is kept.
 */
const fs = require('fs');
const path = require('path');
const { hex, NRC, replyTo } = require('./kit/diag');
const { exitPosition } = require('./seats_backend');

const FAS = 0x6D;
const DID = Object.freeze({ CONFIG_HW: 0xD700, HALL: 0xD702, INIT: 0xD704, MOTOR: 0xD708, SWITCHES: 0xD712 });
const READS = Object.freeze([DID.CONFIG_HW, DID.HALL, DID.INIT, DID.MOTOR, DID.SWITCHES]);

// the axes we show: their index in D700 / D702 (x2) / D708, and their switches' bytes in D712 (+, -).
// plus / minus: where the motor's PLUS and MINUS take the seat (TAB_STATUS_MOTOR: "Plus, vor, auf"; "Minus,
// zurueck, ab"). toward: the end the app counts the axis toward (seats_backend.js: fore 0 = fully forward ..
// 1 = fully back; height 0 = fully down .. 1 = fully up).
// Which way the Hall COUNTER runs is not assumed: it is learned on the car (SeatProbe, rises), from the counter
// moving while the module reports its motor (D708) or the seat's switch (D712) on PLUS or MINUS. A direction
// read off photos or a screen is easy to get backwards (on the G30 it was: 0.2.2's share of the counter range read
// as the opposite of the photos until it was seen to be the raw range; the counter rises toward the front), and a
// wrong one would drive the seat toward the wheel: so nothing is shown as a share, and no target is worked out,
// before an axis has shown its direction on the car.
const AXES = Object.freeze({
    slv: { i: 0, sw: [0, 1], norm: [1, 2], plus: 'front', minus: 'back', toward: 'back' },   // fore / aft (SLV)
    shv: { i: 1, sw: [2, 3], norm: [6, 7], plus: 'up', minus: 'down', toward: 'up' },          // height (SHV)
    lnv: { i: 2, sw: [4, 5], norm: [8, 9], plus: null, minus: null, toward: null },           // backrest: not used yet
});
const MIN_TRAVEL = 500;          // counts between the ends seen before a position counts as a share of the travel
const MIN_STEP = 3;              // counts a poll must move for a direction sample
const VOTES = 2;                 // agreeing samples (and twice the disagreeing ones) to learn a direction
const HALL_MIN = 8192, HALL_MAX = 57344;
const TRAVEL_FILE = 'bre_seat_travel.json';

const u16 = (d, at) => (d.length >= at + 2 ? (d[at] << 8) | d[at + 1] : null);

/** D700 -> { slv: 0 | 1 | 2 | null, ... } (2 = motor and Hall sensor). */
function parseConfig(d) {
    const out = {};
    Object.keys(AXES).forEach((a) => { const v = d[AXES[a].i]; out[a] = v === 0 || v === 1 || v === 2 ? v : null; });
    return out;
}
/** D702 -> { slv: counter | null, ... }; a counter outside 8192..57344 is none. */
function parseHall(d) {
    const out = {};
    Object.keys(AXES).forEach((a) => { const v = u16(d, 2 * AXES[a].i); out[a] = v !== null && v >= HALL_MIN && v <= HALL_MAX ? v : null; });
    return out;
}
/** D704 -> { initialised: true | false | null, normed: { slv: true | false | null, ... } }. */
function parseInit(d) {
    const normed = {};
    Object.keys(AXES).forEach((a) => {
        const p = d[AXES[a].norm[0]], m = d[AXES[a].norm[1]];
        normed[a] = p === undefined || m === undefined ? null : p === 2 && m === 2 ? null : p === 1 && m === 1;
    });
    return { initialised: d[0] === 1 ? true : d[0] === 0 || d[0] === 255 ? false : null, normed: normed };
}
/** D708 -> { slv: 'off' | 'plus' | 'minus' | null, ... }. */
function parseMotor(d) {
    const out = {};
    Object.keys(AXES).forEach((a) => { const v = d[AXES[a].i]; out[a] = v === 0 ? 'off' : v === 1 ? 'plus' : v === 2 ? 'minus' : null; });
    return out;
}
/** D712 -> { pressed: any switch of ours held, axes: { slv: 'plus' | 'minus' | false | null } }. */
function parseSwitches(d) {
    const axes = {};
    let pressed = false;
    Object.keys(AXES).forEach((a) => {
        const p = d[AXES[a].sw[0]], m = d[AXES[a].sw[1]];
        axes[a] = p === 1 && m !== 1 ? 'plus' : m === 1 && p !== 1 ? 'minus'
            : [p, m].every((v) => v === 0 || v === 2) ? false : null;
        if (p === 1 || m === 1) pressed = true;
    });
    return { pressed: pressed, axes: axes };
}

class SeatLink {
    /** link: the DmeLink (its diag and available, once init() ran). */
    constructor(link, log) {
        this.link = link; this.log = log;
    }

    get available() { return !!(this.link && this.link.available && this.link.diag); }

    /** One of READS from the seat module: { ok, data[] } or { ok: false, nrc, reason }. Never throws. */
    async read(did, timeoutMs) {
        if (READS.indexOf(did) < 0) return { ok: false, nrc: null, reason: 'not a read BRE Hub makes' };
        if (!this.available) return { ok: false, nrc: null, reason: 'no diagnostic link' };
        const diag = this.link.diag, req = [did >> 8, did & 0xFF], quiet = diag.quiet;
        diag.quiet = true;                      // polled while the probe is open: our own log lines say what matters
        try {
            const reply = await diag.physical(FAS, 0x22, req, timeoutMs || 1500, replyTo(0x22, req), { maxRetries: 1 });
            if (!reply || !reply.length) return { ok: false, nrc: null, reason: 'timeout' };
            if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
            if (reply[0] === 0x62) return { ok: true, data: reply.slice(3) };
            return { ok: false, nrc: null, reason: 'unexpected ' + hex(reply[0]) };
        } catch (e) {
            return { ok: false, nrc: null, reason: String(e && e.message || e) };
        } finally {
            diag.quiet = quiet;
        }
    }
}

/**
 * What the probe has seen. tick() reads once (the module's make-up the first time, then the positions, the
 * motors and the switches); main.js calls it about once a second while the probe's list is open.
 */
class SeatProbe {
    constructor(seatLink, log, dataDir) {
        this.seat = seatLink; this.log = log;
        this.file = dataDir ? path.join(dataDir, TRAVEL_FILE) : null;
        this.state = 'idle';            // idle | reading | found | none | nolink
        this.reason = null;             // why 'none': the module's refusal or 'timeout'
        this.config = null; this.init = null; this.hall = null; this.motor = null; this.switches = null;
        const saved = this._load();
        this.travel = saved.travel;     // { slv: [min, max], ... }: the lowest and highest counter seen
        this.rises = saved.rises;       // { slv: 'plus' | 'minus' }: the motor direction that makes the counter rise
        this._votes = {}; this._prev = null;
        this.busy = false; this._saveAt = 0; this._dirty = false; this._last = '';
    }

    _load() {
        const out = { travel: {}, rises: {} };
        try {
            const t = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            Object.keys(AXES).forEach((a) => {
                const r = t && t[a];
                if (Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === 'number' && v >= HALL_MIN && v <= HALL_MAX)) out.travel[a] = [r[0], r[1]];
                const d = t && t.rises && t.rises[a];
                if (AXES[a].plus && (d === 'plus' || d === 'minus')) out.rises[a] = d;
            });
        } catch (e) { /* none yet */ }
        return out;
    }

    _save() {
        if (!this.file || !this._dirty || Date.now() - this._saveAt < 2000) return;
        this._dirty = false; this._saveAt = Date.now();
        const doc = Object.assign({}, this.travel, { rises: this.rises });
        try { fs.writeFileSync(this.file, JSON.stringify(doc)); } catch (e) { this.log.warn('seat travel: ' + e); }
    }

    /** Forget the measured ends and the learned directions (to measure them again). */
    resetTravel() { this.travel = {}; this.rises = {}; this._votes = {}; this._dirty = true; this._saveAt = 0; this._save(); }

    /** Where a rising counter takes the seat on this axis ('front' | 'back' | 'up' | 'down'), or null (not learned). */
    risesToward(a) {
        const d = this.rises[a], ax = AXES[a];
        return ax && ax.plus && d ? (d === 'plus' ? ax.plus : ax.minus) : null;
    }

    /** Both ends of the axis seen (at least MIN_TRAVEL apart) and its direction learned. */
    measured(a) {
        const r = this.travel[a];
        return !!(r && this.risesToward(a) && r[1] - r[0] >= MIN_TRAVEL);
    }

    /** A counter as the app counts the axis: fore 0 front .. 1 back, height 0 down .. 1 up; null unmeasured. */
    fraction(a, count) {
        const r = this.travel[a];
        if (!this.measured(a) || count === null || count === undefined) return null;
        const up = (count - r[0]) / (r[1] - r[0]);
        return Math.max(0, Math.min(1, this.risesToward(a) === AXES[a].toward ? up : 1 - up));
    }

    /** The counter for a fraction of the axis (the reverse of fraction()); null unmeasured. */
    countFor(a, f) {
        const r = this.travel[a];
        if (!this.measured(a)) return null;
        const g = Math.max(0, Math.min(1, f));
        const up = this.risesToward(a) === AXES[a].toward ? g : 1 - g;
        return Math.round(r[0] + up * (r[1] - r[0]));
    }

    /**
     * Learn which way the counters run: between two polls, an axis whose counter moved while the module reported
     * its motor (D708), else the seat's switch (D712), on PLUS or MINUS is one sample. VOTES agreeing samples, and
     * at least twice the disagreeing ones, set the direction; a learned one that the samples come to contradict
     * is dropped again (the shares and the target go with it).
     */
    _learn() {
        const prev = this._prev;
        this._prev = this.hall;
        if (!prev || !this.hall) return;
        Object.keys(AXES).forEach((a) => {
            if (!AXES[a].plus) return;
            const v = this.hall[a], p = prev[a];
            if (v === null || p === null || p === undefined || Math.abs(v - p) < MIN_STEP) return;
            const mo = this.motor && this.motor[a], sw = this.switches && this.switches.axes[a];
            const run = mo === 'plus' || mo === 'minus' ? mo : sw === 'plus' || sw === 'minus' ? sw : null;
            if (!run) return;
            const sample = (v > p) === (run === 'plus') ? 'plus' : 'minus';
            const n = this._votes[a] || (this._votes[a] = { plus: 0, minus: 0 });
            n[sample]++;
            const other = sample === 'plus' ? 'minus' : 'plus';
            if (n[sample] >= VOTES && n[sample] >= 2 * n[other] && this.rises[a] !== sample) {
                this.rises[a] = sample; this._dirty = true;
                this.log.info('seat probe: ' + a + ' counter rises toward the ' + this.risesToward(a) + ' (' + n.plus + ' / ' + n.minus + ' samples)');
            } else if (this.rises[a] && this.rises[a] !== sample && n[sample] * 2 > n[other]) {
                delete this.rises[a]; this._dirty = true;
                this.log.warn('seat probe: ' + a + ' direction contradicted (' + n.plus + ' / ' + n.minus + '): learning it again');
            }
        });
    }

    /** Where the axis is now, 0..100 as the app counts it (fore: % back; height: % up), or null. */
    percent(a) {
        const f = this.fraction(a, this.hall && this.hall[a]);
        return f === null ? null : Math.round(100 * f);
    }

    /**
     * Seat Easy Access's exit position for the seat as it is now, as counters: { slv, shv }, or null while the
     * fore / aft and height ends are not measured. The same rule as the move (seats_backend.exitPosition): back to
     * offset (0..1) of the travel, never forward of where it is, fully down. Read only: nothing moves.
     */
    exitCounts(offset) {
        const fore = this.fraction('slv', this.hall && this.hall.slv), height = this.fraction('shv', this.hall && this.hall.shv);
        if (fore === null || height === null) return null;
        const exit = exitPosition({ fore: fore, height: height, back: null }, offset);
        return { slv: this.countFor('slv', exit.fore), shv: this.countFor('shv', exit.height) };
    }

    async tick() {
        if (this.busy) return;
        this.busy = true;
        try {
            if (!this.seat.available) { this.state = 'nolink'; this._note('seat probe: no diagnostic link'); return; }
            if (!this.config) {
                if (this.state !== 'found') this.state = 'reading';
                const c = await this.seat.read(DID.CONFIG_HW);
                if (!c.ok) {
                    this.state = 'none'; this.reason = c.reason;
                    this._note('seat probe: the driver\'s seat module (0x6D) did not answer D700: ' + c.reason);
                    return;
                }
                this.config = parseConfig(c.data);
                const i = await this.seat.read(DID.INIT);
                this.init = i.ok ? parseInit(i.data) : null;
                this.state = 'found'; this.reason = null;
                this.log.info('seat probe: module found; motors ' + JSON.stringify(this.config) + ' (2 = with a position sensor); ' +
                    'initialised ' + (this.init ? JSON.stringify(this.init) : 'unread: ' + i.reason));
            }
            const h = await this.seat.read(DID.HALL);
            this.hall = h.ok ? parseHall(h.data) : null;
            const m = await this.seat.read(DID.MOTOR);
            this.motor = m.ok ? parseMotor(m.data) : null;
            const s = await this.seat.read(DID.SWITCHES);
            this.switches = s.ok ? parseSwitches(s.data) : null;
            if (this.hall) {
                Object.keys(AXES).forEach((a) => {
                    const v = this.hall[a];
                    if (v === null) return;
                    const r = this.travel[a];
                    if (!r) { this.travel[a] = [v, v]; this._dirty = true; } else if (v < r[0]) { r[0] = v; this._dirty = true; } else if (v > r[1]) { r[1] = v; this._dirty = true; }
                });
            }
            this._learn();
            this._save();
            this._note('seat probe: hall ' + (h.ok ? JSON.stringify(this.hall) : h.reason) + ', motors ' + (m.ok ? JSON.stringify(this.motor) : m.reason) +
                ', switches ' + (s.ok ? (this.switches.pressed ? 'pressed' : 'not pressed') : s.reason));
        } catch (e) {
            this.log.warn('seat probe: ' + e);
        } finally {
            this.busy = false;
        }
    }

    /** Log a line when it differs from the last one (the probe polls: no line per poll). */
    _note(line) { if (line !== this._last) { this._last = line; this.log.info(line); } }
}

module.exports = { SeatLink, SeatProbe, FAS, DID, READS, AXES, MIN_TRAVEL, parseConfig, parseHall, parseInit, parseMotor, parseSwitches };
