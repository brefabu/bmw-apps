'use strict';
/**
 * exhaust.js - the exhaust flap: what it should be doing and the one place that decides to send it.
 *
 * Adapted from idrive7-apps apps/live_adjustments (Engine Config): controller.js, adapters.js and auto.js
 * (https://github.com/cauliflowermossgrape/idrive7-apps, commit 8d860de5818a2da11d3a3750aab36866cecf6bde,
 * MIT, Copyright (c) 2026 cauliflowermossgrape). See NOTICE. Ours: one class, the driving modes' flap chosen
 * in Settings, texts as bre_text keys, no tuner (BM3 / MHD) paths.
 *
 *   press('OPEN' | 'CLOSED' | 'OEM')   that mode; the driving mode is not followed
 *   press('DRIVE')                     the flap follows the driving mode, on every change: the Sport modes,
 *                                      the Comfort modes and the Eco Pro modes each to the flap chosen in
 *                                      Settings (exhaustSport / exhaustComfort / exhaustEco)
 *   hold       the DME lets a tester's command go after ~20 s, so Open / Closed is sent again every 15 s
 *   rpm guard  Closed is paused (OEM sent, the DME opens the flap as it needs) while the live engine speed is
 *              above "Closed: hand back above", and resumed 500 rpm below it
 *   no rpm     armed with a limit set, Closed is not held without a live engine speed: a manual Closed becomes
 *              OEM and stays OEM until Closed is pressed again; the driving mode's Closed is paused and comes
 *              back by itself with the engine speed
 *
 * Safety (docs/06, docs/10):
 *   - Disarmed (the default, setting exhaustArm): simulated. Nothing is sent, not even the flap's reads.
 *   - Armed: a command goes only when this DME answered the flap's identifiers (link.readFlap). A DME without
 *     the flap is never written to.
 *   - The choice is remembered (setting exhaustMode, Fabian 15.11.2026): the last Open / Closed / Auto pressed, or
 *     By driving mode (exhaustDrive). Starting sends only that remembered choice, armed and with the flap found
 *     (main.js: linkUp after the first look at the car). Otherwise a command leaves on a press, on a driving mode
 *     change while the driving mode is followed, on the hold's repeat and on the rpm guard handing the flap back.
 *   - Arming sends nothing for a manual choice: what was picked while simulated is dropped (OEM), press again.
 *   - Only with the engine running (a live engine speed of ENGINE_ON_RPM or more): engine off, Open / Closed wait
 *     and go when it starts ("Waits for the engine to run"); Auto goes only as the hand-back of something sent.
 *     A command the DME refuses or leaves unanswered is NOT held (sent again every 15 s): it is tried once more
 *     when the engine next starts, or on a press. (G30, 15.11.2026: a remembered Open sent every 15 s with the engine
 *     off got NRC 22, then no answer - each unanswered one held the diagnostic link 3 s, and the seat's reads
 *     meanwhile were turned away.)
 *   - One command at a time; OEM (the hand-back) is never dropped: pressed while another is in flight, it goes
 *     right after it.
 *   - Nothing is shown as done without the DME's echo; the flap's state is the DME's read-back or unknown.
 *   - The app gone (closed, crashed): the repeats stop and the DME takes the flap back within ~20 s.
 * Every byte goes through link.flap() (dme_link.js).
 */

const MODES = ['OEM', 'OPEN', 'CLOSED'];
const HYST = 500;
const HOLD_MS = 15000;
const ENGINE_ON_RPM = 400;      // a live engine speed from this up: the engine runs (kit/car.js reads less as stopped)

// actualValueModeDrivingExperience (FES): 1-3 Sport, 4-6 Comfort, 7-9 Eco Pro, 10 Adaptive; the plug-in
// hybrids' own numbers: 15 Sport, 16 Sport Individual, 23 Sport+, 28 Boost, 17 Hybrid, 19 Hybrid Comfort,
// 18 Hybrid Eco, 20 Electric, 21 Electric Individual
const PHEV_GROUP = { 15: 'sport', 16: 'sport', 23: 'sport', 28: 'sport', 17: 'comfort', 19: 'comfort',
    18: 'eco', 20: 'eco', 21: 'eco' };
const GROUP_SETTING = { sport: 'exhaustSport', comfort: 'exhaustComfort', eco: 'exhaustEco' };
const GROUP_DEFAULT = { sport: 'OPEN', comfort: 'OEM', eco: 'CLOSED' };

/** The driving mode (name or number) -> 'sport' | 'comfort' | 'eco', or null (initialising, invalid, unknown). */
function modeGroup(raw) {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        if (n >= 1 && n <= 3) return 'sport';
        if (n >= 4 && n <= 6) return 'comfort';
        if (n >= 7 && n <= 9) return 'eco';
        if (n === 10) return 'comfort';
        return PHEV_GROUP[n] || null;
    }
    const s = String(raw).toUpperCase();
    if (/SPORT|BOOST/.test(s)) return 'sport';
    if (/ECO|ELECTRIC|ELEKTR/.test(s)) return 'eco';
    if (/COMFORT|ADAPTIVE|TRAFFIC|HYBRID/.test(s)) return 'comfort';
    return null;
}

const upper = (v) => String(v || '').toUpperCase();

class Exhaust {
    /**
     * o.link      DmeLink (dme_link.js), or null (no diagnostic link: armed commands are refused)
     * o.settings  get(key), set(key, value)
     * o.rpm()     the live engine speed or null (never demo data)
     * o.log; o.onChange() after anything changed; o.holdMs (15000, shorter in the tests)
     */
    constructor(o) {
        this.link = o.link || null;
        this.settings = o.settings;
        this.rpm = o.rpm || (() => null);
        this.log = o.log;
        this.onChange = o.onChange || (() => {});
        this.holdMs = o.holdMs || HOLD_MS;

        this.supported = null;        // armed: this DME has the flap (true / false), null = not looked yet
        this.busy = false;
        this.accepted = null;         // the last command: taken by the DME (or simulated); null = none yet
        this.confirmed = 'UNKNOWN';   // the flap as read back: OPEN | CLOSED | UNKNOWN
        this.blocked = null;          // why an armed command did not go: 'nolink' | 'noflap' | null
        this._oemQueued = false;
        this._flight = null;

        this.desired = 'OEM';
        this.source = 'start';        // start | press | drive
        this.drive = null;            // the last driving mode (raw)
        this.paused = false;          // Closed paused by the rpm guard
        this.why = null;              // 'rpm' (over the limit) | 'nosignal' (driving mode, no engine speed)
        this.sent = 'OEM';            // the mode last sent (or simulated)
        this.rpmLost = false;         // a manual Closed lost its engine speed: OEM until Closed is pressed again
        this.nextAt = 0;
        this._timer = null;
        this._q = Promise.resolve();
        this.waiting = false;         // armed: Open / Closed to send when the engine next runs (engine off, or refused)
        this._engine = null;          // the engine running at the last tick (null: not looked yet)
        this._follow = this.following;
        // the choice made before the app last stopped (By driving mode is its own setting)
        const kept = upper(this.settings.get('exhaustMode'));
        if (!this.following && kept !== 'OEM' && MODES.indexOf(kept) >= 0) { this.desired = kept; this.source = 'press'; }
    }

    /** Keep a manual choice for the next start (a press; arming, which drops one, keeps Auto). */
    _keep(mode) { if (this.settings.get('exhaustMode') !== mode.toLowerCase()) this.settings.set('exhaustMode', mode.toLowerCase()); }

    get armed() { return this.settings.get('exhaustArm') === 'on'; }
    get following() { return this.settings.get('exhaustDrive') === 'on'; }
    get holdOn() { return this.settings.get('exhaustHold') !== 'off'; }
    get limit() { const v = Number(this.settings.get('exhaustCloseLimit')); return v > 0 ? v : null; }

    /** The flap a driving mode gets: Settings' choice for its group, else the default. */
    flapFor(raw) {
        const g = modeGroup(raw);
        if (!g) return null;
        const v = upper(this.settings.get(GROUP_SETTING[g]));
        return MODES.indexOf(v) >= 0 ? v : GROUP_DEFAULT[g];
    }

    /* ---------------------------------------------------------------- the car */

    /**
     * Look at the car again (start, the arm setting changed, the link came up). Read only, and armed only:
     * disarmed, nothing is asked of the car. A disarm waits for the command in flight.
     */
    async refresh() {
        if (!this.armed && this.busy && this._flight) await this._flight;
        this.blocked = null;
        if (!this.armed) { this.supported = null; return; }
        if (!this.link || !this.link.available) { this.supported = null; this.confirmed = 'UNKNOWN'; return; }
        try {
            const f = await this.link.readFlap();
            this.supported = !!f.supported;
            this._confirm(f);
            this.log.info('exhaust: flap ' + (this.supported ? 'found' : 'not found on this DME'));
        } catch (e) {
            this.supported = null;
            this.log.warn('exhaust: flap probe ' + String(e && e.message || e));
        }
    }

    _confirm(f) {
        const p = f && f.commandedPct;
        this.confirmed = p === null || p === undefined ? 'UNKNOWN' : p <= 20 ? 'OPEN' : p >= 80 ? 'CLOSED' : 'UNKNOWN';
    }

    /** The only path to a command. One at a time; OEM pressed meanwhile goes right after. */
    async _setMode(mode) {
        if (MODES.indexOf(mode) < 0) return;
        if (this.busy) {
            if (mode === 'OEM' && this.armed) this._oemQueued = true;
            return;
        }
        let landed;
        this._flight = new Promise((r) => { landed = r; });
        try { await this._send(mode); } finally { landed(); }
    }

    async _send(mode) {
        this.accepted = null;
        this.blocked = null;
        this.busy = true;
        try {
            if (!this.armed) {
                this.accepted = true;                      // simulated: nothing reaches the car
            } else if (!this.link || !this.link.available) {
                this.accepted = false; this.blocked = 'nolink';
            } else if (!this.supported) {
                this.accepted = false; this.blocked = 'noflap';
            } else {
                this.confirmed = 'UNKNOWN';                // unknown until read back
                const r = await this.link.flap(mode);
                this.accepted = !!r.ok;
                this.log.info('exhaust: ' + mode + ' -> ' + (r.ok ? 'taken by the DME' : 'not taken (' + (r.reason || '') + ')'));
            }
        } catch (e) {
            this.accepted = false;
            this.log.warn('exhaust: ' + mode + ': ' + String(e && e.message || e));
        } finally {
            this.busy = false;
        }
        if (this._oemQueued) { this._oemQueued = false; return this._send('OEM'); }
        if (this.armed && this.accepted && this.link) {
            try { this._confirm(await this.link.readFlap()); } catch (e) { this.confirmed = 'UNKNOWN'; }
        }
        return null;
    }

    /* ---------------------------------------------------------------- what is wanted */

    /** What goes to the car now. */
    effective() { return this.desired === 'CLOSED' && this.paused ? 'OEM' : this.desired; }

    /** The choice lit in the menu: 'DRIVE' while the driving mode is followed, else the mode asked for. */
    selected() { return this.following ? 'DRIVE' : this.desired; }

    /** A choice in the menu: 'OPEN' | 'CLOSED' | 'OEM' (the driving mode is no longer followed) or 'DRIVE'. */
    press(mode) {
        if (mode === 'DRIVE') {
            if (!this.following) { this._follow = true; this.settings.set('exhaustDrive', 'on'); }
            this.desired = this.flapFor(this.drive) || 'OEM'; this.source = 'drive';
        } else if (MODES.indexOf(mode) >= 0) {
            if (this.following) { this._follow = false; this.settings.set('exhaustDrive', 'off'); }
            this.desired = mode; this.source = 'press';
            this._keep(mode);
        } else return Promise.resolve();
        this.rpmLost = false;
        if (this.desired === 'CLOSED' && this.source === 'press' && this._blind()) {
            this.desired = 'OEM';
            this.rpmLost = true;
            this.log.warn('exhaust: manual Closed blocked: no engine speed; OEM instead');
        }
        this._pauseFor(this.desired);
        return this.apply(true);
    }

    /** The driving mode changed (or arrived): while it is followed, the flap goes with it. */
    driveMode(raw) {
        const prev = this.drive;
        this.drive = raw;
        if (!this.following || String(prev) === String(raw)) return null;
        const m = this.flapFor(raw);
        if (!m) return null;
        this.desired = m; this.source = 'drive';
        this._pauseFor(m);
        this.log.info('exhaust: driving mode ' + modeGroup(raw) + ' -> ' + m);
        return this.apply(false);
    }

    _pauseFor(m) {
        this.why = m !== 'CLOSED' ? null : this._over() ? 'rpm' : this.source === 'drive' && this._blind() ? 'nosignal' : null;
        this.paused = !!this.why;
    }

    /** The car came up (ignition on): the DME starts on its own strategy, so what is wanted goes again. */
    linkUp() {
        this.sent = 'OEM';
        if (this.following && this.drive !== null) {
            const m = this.flapFor(this.drive);
            if (m) { this.desired = m; this.source = 'drive'; this._pauseFor(m); }
        }
        return this.apply(false);
    }

    /** A setting changed (main.js calls this after refresh() for exhaustArm). */
    settingsChanged(key) {
        if (key === 'exhaustDrive') {
            const v = this.following;
            if (v === this._follow) return Promise.resolve();      // set by a press here: already applied
            this._follow = v;
            if (v && this.drive !== null) {
                const m = this.flapFor(this.drive);
                if (m) { this.desired = m; this.source = 'drive'; this._pauseFor(m); return this.apply(false); }
            }
            if (!v && this.source === 'drive') { this.desired = 'OEM'; this.source = 'press'; return this.apply(false); }
            return Promise.resolve();
        }
        // the flap chosen for the driving mode's group changed: follow it at once
        if ((key === 'exhaustSport' || key === 'exhaustComfort' || key === 'exhaustEco') && this.following && this.source === 'drive') {
            const m = this.flapFor(this.drive);
            if (m && m !== this.desired) { this.desired = m; this._pauseFor(m); return this.apply(false); }
            return Promise.resolve();
        }
        if (key === 'exhaustArm') {
            this._stop();
            if (!this.armed) return Promise.resolve();          // disarmed: simulated from here on
            // Armed just now. A manual choice made while simulated is NOT sent by arming: the flap stays with
            // the car until Open or Closed is pressed again. Only a followed driving mode applies at once.
            this.sent = 'OEM'; this.rpmLost = false; this.accepted = null;
            if (this.following && this.drive !== null) {
                const m = this.flapFor(this.drive);
                if (m) { this.desired = m; this.source = 'drive'; this._pauseFor(m); return this.apply(false); }
            }
            this.desired = 'OEM'; this.source = 'start'; this.paused = false; this.why = null;
            this._keep('OEM');
            return Promise.resolve();
        }
        if (key === 'exhaustHold') {
            this._stop();
            if (this.armed && this.holdOn && this.sent !== 'OEM') this._schedule();
        }
        if (key === 'exhaustCloseLimit') return this.tick();
        return Promise.resolve();
    }

    _over() { const r = this.rpm(), l = this.limit; return !!(l && r !== null && r > l); }
    /** The engine runs: a live engine speed of ENGINE_ON_RPM or more. */
    engineOn() { const r = this.rpm(); return r !== null && r !== undefined && r >= ENGINE_ON_RPM; }
    /** Armed, a limit set and no live engine speed: the guard can't see, so Closed is not held. */
    _blind() { return !!(this.armed && this.limit && this.rpm() === null); }

    /** A few times a second: the engine starting or stopping, the Closed rpm guard and the no-rpm fail-safe. */
    tick() {
        const on = this.engineOn(), started = on && this._engine === false;
        this._engine = on;
        if (this.armed && started && this.waiting) {
            this.waiting = false;
            this.log.info('exhaust: the engine runs: ' + this.effective());
            return this.apply(true);
        }
        if (this.armed && !on && this.sent === 'OPEN') {
            // the engine stopped while Open was held: no more repeats, the DME has the flap; Open again on the next start
            this._stop(); this.sent = 'OEM'; this.waiting = true;
            this.log.info('exhaust: the engine stopped: Open waits for the next start');
            return Promise.resolve().then(() => this.onChange());
        }
        if (this.source === 'press' && this.desired === 'CLOSED' && this._blind()) {
            this.rpmLost = true;
            this.desired = 'OEM';
            this.paused = false; this.why = null;
            this._stop();                                   // no queued repeat may send Closed again
            this.log.warn('exhaust: manual Closed lost the engine speed: OEM; press Closed again');
            return this.apply(true);
        }
        if (this.desired !== 'CLOSED') { this.paused = false; this.why = null; return Promise.resolve(); }
        const r = this.rpm(), l = this.limit;
        if (!l) { if (this.paused) { this.paused = false; this.why = null; return this.apply(false); } return Promise.resolve(); }
        if (r === null) {
            if (this.armed && this.why !== 'nosignal') {
                this.paused = true; this.why = 'nosignal';
                this.log.warn('exhaust: Closed paused: no engine speed; OEM');
                return this.apply(false);
            }
            return Promise.resolve();
        }
        if (this.paused && this.why === 'nosignal' && r >= l - HYST) { this.why = 'rpm'; return Promise.resolve(); }
        if (!this.paused && r > l) { this.paused = true; this.why = 'rpm'; this.log.info('exhaust: Closed paused at ' + Math.round(r) + ' rpm'); return this.apply(false); }
        if (this.paused && r < l - HYST) { this.paused = false; this.why = null; this.log.info('exhaust: Closed resumed at ' + Math.round(r) + ' rpm'); return this.apply(false); }
        return Promise.resolve();
    }

    /** Send the effective mode if it changed (force: a press always sends). */
    apply(force) {
        this._q = this._q.then(async () => {
            const eff = this.effective();
            if (!force && eff === this.sent) return;
            this._stop();
            if (this.armed && !this.engineOn()) {
                // the engine off (or its speed unknown): Open / Closed wait for it to run; Auto goes only as the
                // hand-back of something sent
                if (eff !== 'OEM') { this.waiting = true; this.sent = 'OEM'; this.log.info('exhaust: ' + eff + ' waits for the engine'); return; }
                if (this.sent === 'OEM') { this.waiting = false; return; }
            }
            this.waiting = false;
            await this._setMode(eff);
            this.sent = eff;
            if (eff !== 'OEM' && this.armed) {
                // refused or unanswered: not held; once more when the engine next starts (or on a press)
                if (this.accepted === false) { this.waiting = true; this.log.warn('exhaust: ' + eff + ' not taken: tried again when the engine next starts'); }
                else if (this.holdOn) this._schedule();
            }
        }).catch((e) => this.log.error('exhaust', e)).then(() => this.onChange());
        return this._q;
    }

    _schedule() {
        this._stop();
        this.nextAt = Date.now() + this.holdMs;
        this._timer = setTimeout(() => {
            this._q = this._q.then(async () => {
                const eff = this.effective();
                if (eff === 'OEM' || eff !== this.sent || !this.armed || !this.holdOn) return;
                if (!this.engineOn()) { this.waiting = true; this.sent = 'OEM'; return; }     // the engine stopped
                await this._setMode(eff);
                if (this.accepted === false) { this.waiting = true; this.log.warn('exhaust: hold of ' + eff + ' not taken: stopped'); return; }
                this._schedule();
            }).catch((e) => this.log.error('exhaust hold', e)).then(() => this.onChange());
        }, this.holdMs);
        if (this._timer.unref) this._timer.unref();
    }

    _stop() { clearTimeout(this._timer); this._timer = null; this.nextAt = 0; }

    /** Stop the repeats (the app is going). The DME takes the flap back by itself. */
    close() { this._stop(); }

    /** A line for the screen: { key (bre_text), vars, warn } or null. */
    note() {
        if (this.blocked === 'noflap') return { key: 'ex.noFlap', warn: true };
        if (this.blocked === 'nolink') return { key: 'ex.noLink', warn: true };
        if (this.rpmLost) return { key: 'ex.rpmLost', warn: true };
        if (this.desired === 'CLOSED' && this.paused && this.why === 'nosignal') return { key: 'ex.pausedNoRpm', warn: true };
        if (this.desired === 'CLOSED' && this.paused) return { key: 'ex.pausedRpm', vars: { rpm: this.limit }, warn: true };
        if (this.armed && this.accepted === false) return { key: 'ex.notTaken', warn: true };
        if (this.armed && this.waiting) return { key: 'ex.waitEngine', warn: false };
        if (!this.armed) return { key: 'ex.simulated', warn: false };
        if (this.sent !== 'OEM' && this.holdOn && this.nextAt) return { key: 'ex.holding', warn: false };
        return { key: 'ex.armed', warn: false };
    }

    view() {
        return {
            desired: this.desired, selected: this.selected(), effective: this.effective(), sent: this.sent,
            armed: this.armed, supported: this.supported, busy: this.busy, accepted: this.accepted,
            confirmed: this.confirmed, following: this.following, group: modeGroup(this.drive),
            holdOn: this.holdOn, note: this.note(),
        };
    }
}

module.exports = { Exhaust, modeGroup, MODES, HYST, HOLD_MS, GROUP_SETTING, GROUP_DEFAULT };
