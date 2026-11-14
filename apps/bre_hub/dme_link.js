'use strict';
/**
 * dme_link.js - BRE Hub's link to the engine controller (DME, diagnostic address 0x12) over the head unit's
 * own diagnostic transport (kit/diag.js). The only file in BRE Hub that sends a request to the car.
 *
 * Adapted from idrive7-apps apps/live_adjustments/diaglink.js and real_adapters.js
 * (https://github.com/cauliflowermossgrape/idrive7-apps, commit 8d860de5818a2da11d3a3750aab36866cecf6bde,
 * MIT, Copyright (c) 2026 cauliflowermossgrape). See NOTICE.
 *
 * What may leave, and nothing else (docs/06):
 *   reads   22 <DID>: F190 (VIN, for the car's model: car_ident.js), 62FD and 64FD (the electric exhaust flap)
 *   writes  exactly the three requests of FLAP below, BMW's own 0x2F job on DID 0x60FD:
 *             2F 60FD 03 03E8   flap open   (10 % duty, the SGBD's "Auffahren" band)
 *             2F 60FD 03 2328   flap closed (90 % duty, "Zufahren")
 *             2F 60FD 00        control back to the DME
 *           The DME drops a tester's command by itself after about 20 s.
 * flap() is the only way to a write, and it takes a name, not bytes. exhaust.js decides when to call it
 * (armed in Settings, the flap found on this DME); nothing here decides to send.
 */
const { Diag, hex, NRC, replyTo } = require('./kit/diag');

const DME = 0x12;
const DID_VIN = [0xF1, 0x90];
const DID_FLAP_COMMANDED = [0x62, 0xFD];    // ASW_EL_AGK: the duty a tester commanded, percent x 100
const DID_FLAP_POSITION = [0x64, 0xFD];     // ASG_EL_AGK: the output position
const READS = [DID_VIN, DID_FLAP_COMMANDED, DID_FLAP_POSITION];
const FLAP = Object.freeze({
    OPEN: Object.freeze([0x60, 0xFD, 0x03, 0x03, 0xE8]),
    CLOSED: Object.freeze([0x60, 0xFD, 0x03, 0x23, 0x28]),
    OEM: Object.freeze([0x60, 0xFD, 0x00]),
});

const bytesToHex = (b) => (b || []).map((x) => hex(x)).join(' ');

const GAP_MS = 25;              // between two requests (kit/runtime/readonly-diag.js, which Live Data uses on cars)
const COOL_MS = 1500;           // after a request that got no answer or was turned away: the transport may still be
                                // waiting on it, and turns everything away meanwhile (G30, 15.11.2026)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The transport turns requests away (APP_REQUEST_TEMPORARILY_NOT_ACCEPTED) when they come back to back, and
 * other apps and BMW's own services use it too (seen on the G30, 15.11.2026). So, as the kit's read-only link
 * does: every request of this Diag - the DME's and the seat's (seat_link.js, seat_drive.js share it) - one at a
 * time and at least GAP_MS after the one before, and a busy transport tried again soon (100, 200, 300 ... ms)
 * rather than after seconds. After a request without an answer, or turned away, the next waits COOL_MS - except
 * an urgent one (opts.urgent: a seat STOP), which still waits its turn but never the pause.
 */
function pace(diag) {
    const raw = diag.physical.bind(diag);
    let chain = Promise.resolve(), next = 0;
    diag.physical = function () {
        const args = arguments, urgent = !!(args[5] && args[5].urgent);
        const run = () => sleep(urgent ? 0 : Math.max(0, next - Date.now()))
            .then(() => raw.apply(null, args))
            .then((r) => { next = Date.now() + (r ? GAP_MS : COOL_MS); return r; },
                (e) => { next = Date.now() + COOL_MS; throw e; });
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p;
    };
    diag.busyMs = 100;
    diag.busyLog = false;
    return diag;
}

class DmeLink {
    constructor(signals, log) {
        this.signals = signals; this.log = log;
        this.diag = null;
        this.available = false;
        this._onAvailable = [];
    }

    /** fn(on) when the diagnostic link comes up or goes away (apps start at boot, often before it). */
    onAvailable(fn) { this._onAvailable.push(fn); }

    async init() {
        this.diag = await new Diag(this.signals, this.log).init();
        pace(this.diag);
        this.available = !!this.diag.available;
        this.diag.on('available', (on) => {
            this.available = !!on;
            this._onAvailable.forEach((fn) => { try { fn(this.available); } catch (e) { this.log.error(e); } });
        });
        return this;
    }

    /** Read one of READS from the DME. Resolves { ok, data[] } or { ok: false, nrc, reason }. Never throws. */
    async readDid(did, timeoutMs) {
        if (!READS.some((d) => d[0] === did[0] && d[1] === did[1])) return { ok: false, nrc: null, reason: 'not a read BRE Hub makes' };
        if (!this.available) return { ok: false, nrc: null, reason: 'no diagnostic link' };
        try {
            const reply = await this.diag.physical(DME, 0x22, [did[0], did[1]], timeoutMs || 2000, replyTo(0x22, did));
            if (!reply || !reply.length) return { ok: false, nrc: null, reason: 'timeout' };
            if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
            if (reply[0] === 0x62) return { ok: true, data: reply.slice(3) };       // 62 <did hi> <did lo> <data...>
            return { ok: false, nrc: null, reason: 'unexpected ' + hex(reply[0]) };
        } catch (e) {
            return { ok: false, nrc: null, reason: String(e && e.message || e) };
        }
    }

    /** The VIN as the DME has it, or null. For the caller's eyes only: never logged, never saved (docs/10, rule 7). */
    async readVin() {
        const r = await this.readDid(DID_VIN);
        if (!r.ok) return null;
        const vin = r.data.map((c) => String.fromCharCode(c)).join('').replace(/[^A-Z0-9]/gi, '');
        return vin.length === 17 ? vin.toUpperCase() : null;
    }

    /**
     * The electric exhaust flap, read only: { supported, commandedPct }. supported: this DME answered one of
     * the flap's identifiers, so it has the flap and takes the 0x60FD job.
     */
    async readFlap() {
        const asw = await this.readDid(DID_FLAP_COMMANDED);
        const asg = await this.readDid(DID_FLAP_POSITION);
        return {
            supported: asw.ok || asg.ok,
            commandedPct: asw.ok && asw.data.length >= 2 ? ((asw.data[0] << 8) | asw.data[1]) / 100 : null,
        };
    }

    /**
     * The one write: mode 'OPEN' | 'CLOSED' | 'OEM' as the request in FLAP. Resolves { ok } on the DME's own
     * echo (6F 60FD ..), else { ok: false, reason }. Throws only for a name that is not a flap mode.
     */
    async flap(mode) {
        const data = Object.prototype.hasOwnProperty.call(FLAP, mode) ? FLAP[mode] : null;
        if (!data) throw new Error('not a flap mode: ' + mode);
        if (!this.available) return { ok: false, reason: 'no diagnostic link' };
        this.log.info('UDS -> DME 2F ' + bytesToHex(data));
        const reply = await this.diag.physical(DME, 0x2F, data.slice(), 3000, replyTo(0x2F, data));
        if (!reply || !reply.length) return { ok: false, reason: 'timeout' };
        if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
        return { ok: true };
    }
}

module.exports = { DmeLink, DME, FLAP, READS, pace, GAP_MS, COOL_MS };
