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
 * measures it), kept in bre_seat_travel.json in the app's data folder. Nothing else is kept.
 */
const fs = require('fs');
const path = require('path');
const { hex, NRC, replyTo } = require('./kit/diag');

const FAS = 0x6D;
const DID = Object.freeze({ CONFIG_HW: 0xD700, HALL: 0xD702, INIT: 0xD704, MOTOR: 0xD708, SWITCHES: 0xD712 });
const READS = Object.freeze([DID.CONFIG_HW, DID.HALL, DID.INIT, DID.MOTOR, DID.SWITCHES]);

// the axes we show: their index in D700 / D702 (x2) / D708, and their switches' bytes in D712 (+, -)
const AXES = Object.freeze({
    slv: { i: 0, sw: [0, 1], norm: [1, 2] },      // fore / aft (Sitzlaengsverstellung)
    shv: { i: 1, sw: [2, 3], norm: [6, 7] },      // height (Sitzhoehenverstellung)
    lnv: { i: 2, sw: [4, 5], norm: [8, 9] },      // backrest (Lehnenneigungsverstellung)
});
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
/** D712 -> { pressed: any switch of ours held, axes: { slv: true | false | null } }. */
function parseSwitches(d) {
    const axes = {};
    let pressed = false;
    Object.keys(AXES).forEach((a) => {
        const s = AXES[a].sw.map((i) => d[i]);
        axes[a] = s.some((v) => v === 1) ? true : s.every((v) => v === 0 || v === 2) ? false : null;
        if (axes[a]) pressed = true;
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
        this.travel = this._load();     // { slv: [min, max], ... }
        this.busy = false; this._saveAt = 0; this._dirty = false; this._last = '';
    }

    _load() {
        try {
            const t = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const out = {};
            Object.keys(AXES).forEach((a) => {
                const r = t && t[a];
                if (Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === 'number' && v >= HALL_MIN && v <= HALL_MAX)) out[a] = [r[0], r[1]];
            });
            return out;
        } catch (e) { return {}; }
    }

    _save() {
        if (!this.file || !this._dirty || Date.now() - this._saveAt < 2000) return;
        this._dirty = false; this._saveAt = Date.now();
        try { fs.writeFileSync(this.file, JSON.stringify(this.travel)); } catch (e) { this.log.warn('seat travel: ' + e); }
    }

    /** Forget the measured travel (to measure it again). */
    resetTravel() { this.travel = {}; this._dirty = true; this._saveAt = 0; this._save(); }

    /** Where an axis is in its measured travel, 0..100, or null (no position, or less than 500 counts measured). */
    percent(a) {
        const h = this.hall && this.hall[a], r = this.travel[a];
        if (h === null || h === undefined || !r || r[1] - r[0] < 500) return null;
        return Math.round(100 * (h - r[0]) / (r[1] - r[0]));
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
                this._save();
            }
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

module.exports = { SeatLink, SeatProbe, FAS, DID, READS, AXES, parseConfig, parseHall, parseInit, parseMotor, parseSwitches };
