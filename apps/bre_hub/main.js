'use strict';
/**
 * BRE Hub - one app for the whole car (docs/09). One page, laid out like iDrive 7's My Vehicle (page_home.js):
 * a list on the left, the car on the right. What it does so far:
 *   Seat Easy Access   the driver's seat back and down when the car is switched off, back when it starts
 *                      (seats_backend.js; the real seat with the setting on "armed": seat_drive.js, parked only)
 *   Exhaust flap       open / closed / auto, held against the DME's timeout, or by the driving mode (exhaust.js)
 *
 * main.js is the shell: the shared state the page gets (app), the render loop, settings and the car's signals.
 * Runs on the head unit's Node 8: no ?. / ?? / object spread / catch without a binding.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const parkedWatch = require('./kit/parked').watch;
const D = require('./bre_design');
const text = require('./bre_text');
const seatsLib = require('./seats_backend');
const { DmeLink } = require('./dme_link');
const { Exhaust } = require('./exhaust');
const { CarIdent } = require('./car_ident');
const { SeatLink, SeatProbe } = require('./seat_link');
const { SeatDrive, SeatMover, RealBackend } = require('./seat_drive');
const home = require('./page_home');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const RPM_STALE_MS = 5000;              // the exhaust's Closed guard: an engine speed older than this is none
// why Take from M1 took nothing (seat_link.js watchM1), as Easy Access's notes (bre_text ee.*)
const M1_WHY = { m2: 'ee.m1Other', switch: 'ee.m1Switch', timeout: 'ee.m1NotSeen', stopped: 'ee.m1Stopped', unread: 'ee.m1Unread' };
const EXHAUST_KEYS = ['exhaustArm', 'exhaustHold', 'exhaustCloseLimit', 'exhaustDrive', 'exhaustSport', 'exhaustComfort', 'exhaustEco'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        text.setLanguage(settings.get('language'));

        // scaled signals; a simulated drive only with Demo on. gear: the selector (P); condition: the vehicle state,
        // whose drive-ready edges are Seat Easy Access's "started" and "switched off"
        const car = new Car(ctx, ['rpm', 'speed', 'gear', 'condition']);
        const parked = parkedWatch(ctx, log);
        const positions = new seatsLib.Positions(ctx.dataDir, log);

        let loop = null;
        const repaint = () => { if (loop && loop.kick) loop.kick(); };

        // the engine controller: read only until the exhaust flap is armed in Settings (dme_link.js, exhaust.js)
        const link = new DmeLink(ctx.signals, log);
        // the Closed guard's engine speed: live and fresh only, never the demo drive
        const rpm = () => {
            const d = car.data();
            if (d.demo || !G.isNum(d.rpm) || d.rpm < 0 || !car.lastCar || Date.now() - car.lastCar > RPM_STALE_MS) return null;
            return d.rpm;
        };
        const exhaust = new Exhaust({ link: link, settings: settings, rpm: rpm, log: log, onChange: repaint });
        const ident = new CarIdent({ link: link, settings: settings, log: log, dataDir: ctx.dataDir });
        // the seat probe: reads the driver's seat module through the same diagnostic link, never writes (seat_link.js)
        const seatLink = new SeatLink(link, log);
        const seatProbe = new SeatProbe(seatLink, log, ctx.dataDir);

        // Seat Easy Access moves the real seat only with the setting on "armed", and only while the car is parked
        // for sure: a real speed under 1 km/h (none read = not parked) and the selector in P (when the car says)
        const armed = () => settings.get('easyEntry') === 'armed';
        const parkedStrict = () => {
            const kmh = parked.speed(), stage = car.live && car.live.stage;
            return kmh !== null && kmh < 1 && (stage === undefined || stage === 'P');
        };
        const mover = new SeatMover({ probe: seatProbe, seatLink: seatLink, drive: new SeatDrive(link, log), log: log,
            guard: () => armed() && parkedStrict() });
        const realSeats = new RealBackend({ probe: seatProbe, mover: mover, log: log });
        // a fresh position, patiently: right after the car is switched off the link is often busy (G30, 15.11.2026)
        realSeats.refresh = async () => {
            if (seatProbe.fresh(1000)) return;            // read just now
            const asked = Date.now();
            for (;;) {
                await seatProbe.tick();
                if (seatProbe.hallAt >= asked || Date.now() - asked > 10000) return;
                await new Promise((r) => setTimeout(r, 1000));
            }
        };
        const demoSeats = seatsLib.createBackend('demo', log);
        // the backend the setting picks, asked each time (the setting can change while the app runs)
        const seats = {
            current() { return armed() ? realSeats : demoSeats; },
            get mode() { return this.current().mode; },
            status() { return this.current().status(); },
            refresh() { const b = this.current(); return b.refresh ? b.refresh() : Promise.resolve(); },
            goTo(seat, target, opts) { return this.current().goTo(seat, target, opts); },
            jog(seat, axis, dir) { return this.current().jog(seat, axis, dir); },
            stop(seat) { demoSeats.stop(seat); realSeats.stop(seat); },
            reason() { return armed() ? mover.reason : null; },
            /** What a real move does right now ({ axis, now, target, ... }), or null (none, or the demo). */
            progress() { return armed() ? mover.progress : null; },
        };
        const easyEntry = new seatsLib.EasyEntry(seats, positions, log);
        easyEntry.setOffset(settings.get('seatOffset'));
        easyEntry.sync();                                  // an OUT kept from the other mode means nothing now

        // The page has its own list, with Settings in it: the kit's header keeps the app's name and no tabs
        // (the kit would add a Settings tab for BTN_SETTINGS, which stays in app.json for the HMI's own bar).
        const display = ctx.display;
        if (display) display.hasSettings = () => false;

        const app = {
            ctx, settings, log, car, parked, seats, positions, easyEntry, exhaust, ident, seatProbe,
            /** The seat speed test (seat_drive.js): run() armed and parked only; state() for the page. */
            seatTest: {
                run() {
                    if (!armed() || !parkedStrict() || mover.busy) return;
                    mover.measureSpeed().then(repaint, (e) => log.error('seat speed test', e));
                    repaint();
                },
                state() { return { testing: mover.testing, tested: mover.tested }; },
            },
            /**
             * Take from M1 (seat_link.js watchM1): position 1 from the seat's own memory, read only - the driver
             * holds M1 on the door until the seat stops, and that position is saved. Armed only (the real seat's
             * positions). run() starts it; saveNow() gives up on M1 and saves the seat as it is; state() for the page.
             */
            seatM1: {
                run() {
                    if (!armed() || mover.busy || seatProbe.watching) return;
                    const moving = () => mover.busy || easyEntry.state === 'MOVING_OUT' || easyEntry.state === 'MOVING_IN';
                    seatProbe.watchM1({ stopIf: moving, onChange: repaint }).then((r) => {
                        if (r.ok) return easyEntry.savePosition('m1');
                        if (r.why !== 'cancelled') easyEntry.note(M1_WHY[r.why] || 'ee.m1NotSeen');
                        return null;
                    }).then(repaint, (e) => log.error('seat M1', e));
                    repaint();
                },
                saveNow() {
                    seatProbe.cancelWatch();
                    easyEntry.savePosition().then(repaint, (e) => log.error('seat save', e));
                },
                state() { return seatProbe.watching; },
            },
            /** The last requests to the car, newest first (dme_link.js pace: docs/07, rule 7). */
            journal() { return (link.diag && link.diag.journal) || []; },
            /** The page target the controller is on (its key), or null. */
            focusKey() {
                const k = display && display.focusKey;
                return typeof k === 'string' && k.indexOf('tgt:') === 0 ? k.slice(4) : null;
            },
            /** Put the controller on the page target with this key (after the list changed). */
            focus(key) {
                try { if (display && display._focus && display.focusKey) display._focus({ k: 'tgt:' + key }); } catch (e) { log.warn('focus: ' + e); }
            },
            /** The kit's settings: over the page where the kit runs the screen, else the HMI's settings screen. */
            openSettings() {
                try { if (display && display._click) display._click('BTN_SETTINGS'); } catch (e) { log.warn('settings: ' + e); }
            },
        };

        // the car moving stops any automatic seat move at once (docs/07, rule 1)
        setInterval(() => { if (parked.moving()) easyEntry.onCar({ parked: false }, settings.get('easyEntry')); }, 250);
        // Seat Easy Access on the car's own switching: the vehicle state leaving drive-ready (10, FAHREN) is "switched
        // off" (the seat back and down), reaching it is "started" (back to the driving position). Only real data (never
        // the demo drive), and only edges seen while the app runs: the first state read moves nothing.
        let lastState = null, stateAt = 0;
        setInterval(() => {
            const st = car.demoActive ? undefined : car.live && car.live.condition;
            if (st === undefined || st === null || st === lastState) return;
            const prev = lastState;
            lastState = st; stateAt = Date.now();
            const mode = settings.get('easyEntry'), ok = mode === 'armed' ? parkedStrict() : !parked.moving();
            const what = easyEntry.vehicleState(prev, st, mode, ok);
            if (what) log.info('seat easy access: ' + what + ' (vehicle state ' + prev + ' -> ' + st + '), parked ' + ok + ', ' + easyEntry.state);
            repaint();
        }, 250);
        // armed, the car drive-ready: the seat's position kept fresh in the background (one read every 3 s), so that
        // switching off moves the seat at once instead of first waiting for a read on a busy link
        setInterval(() => {
            if (!armed() || mover.busy || seatProbe.busy || home.ui.view === 'seatinfo') return;
            if (!(car.live && car.live.condition === 10)) return;
            // not right after the engine was started or stopped: the link is busy then, and a read left unanswered
            // holds it ~5 s - just when Easy Access needs it
            if (Date.now() - stateAt < 6000) return;
            seatProbe.readPosition().catch(() => {});
        }, 3000);
        // the exhaust's Closed guard, also while the app is not on screen
        setInterval(() => { exhaust.tick().catch((e) => log.error('exhaust tick', e)); }, 250);
        // the seat probe reads about once a second, only while its list is on screen (drawn in the last 2 s)
        let drawnAt = 0;
        setInterval(() => {
            if (home.ui.view !== 'seatinfo' || Date.now() - drawnAt > 2000) return;
            seatProbe.tick().then(repaint).catch((e) => log.error('seat probe', e));
        }, 1000);

        function render() {
            drawnAt = Date.now();
            const t = D.theme(ctx), d = car.data();
            const cv = ctx.canvas(D.W, D.H).clear(t.bg);
            try {
                home.draw(cv, t, app, d);
            } catch (e) {
                log.error('page', e);
                cv.text(text.T('page.error'), D.MARGIN, G.TOP + 80, 24, t.crit);
            }
            G.frame(cv, t, [], 0, []);
            return ui.image('MAIN_GFX', cv);
        }

        // without the GPU renderer the page has no buttons of its own: the HMI's bar has these two
        ['BTN_SEAT', 'BTN_EXHAUST'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_SEAT', () => { settings.set('easyEntry', settings.get('easyEntry') === 'off' ? 'demo' : 'off'); return render(); });
        ui.onClick('BTN_EXHAUST', () => {
            const order = ['OEM', 'OPEN', 'CLOSED', 'DRIVE'];
            return exhaust.press(order[(order.indexOf(exhaust.selected()) + 1) % order.length]).then(render);
        });

        settings.onChange((k) => {
            if (k === 'language') text.setLanguage(settings.get('language'));
            if (k === 'seatOffset') easyEntry.setOffset(settings.get('seatOffset'));
            // any change of the mode (off / demo / armed) stops whatever seat move runs
            if (k === 'easyEntry') { easyEntry.manual(); seats.stop('driver'); seatProbe.cancelWatch(); easyEntry.sync(); }
            if (EXHAUST_KEYS.indexOf(k) >= 0) {
                Promise.resolve(k === 'exhaustArm' ? exhaust.refresh() : null)
                    .then(() => exhaust.settingsChanged(k))
                    .then(repaint).catch((e) => log.error('exhaust settings', e));
            }
            repaint();
        });

        // the driving mode (notified on change), also while the app is not on screen: the exhaust may follow it
        ctx.signals.watch(FES, '1', {
            statusFESVehicleDynamicSwitchHMI: (s) => {
                const p = exhaust.driveMode(s && s.actualValueModeDrivingExperience);
                if (p) p.then(repaint);
            },
        }, log).then((s) => log.info('driving mode ' + (s && s.error ? 'error: ' + s.error : 'subscribed')));

        // every display refresh (60 fps) with the GPU renderer; 10 fps in software (PNG frames)
        loop = ctx.loop('MAIN', 10, render);
        render().then(() => log.info('bre_hub: first frame')).catch((e) => log.warn('first render: ' + e));

        // the diagnostic link, after the first frame (it often comes up later than the app, at boot). Read only
        // here: which car this is, and - armed - whether its DME has the flap. Nothing is actuated at start.
        try { await link.init(); } catch (e) { log.warn('diagnostic link: ' + e); }
        const lookAtCar = (on) => Promise.resolve(ident.detect())
            .then(() => exhaust.refresh())
            .then(() => (on ? exhaust.linkUp() : null))
            .then(repaint).catch((e) => log.error('link', e));
        link.onAvailable(lookAtCar);
        // the link up already: the remembered flap choice goes now (armed, the flap found); else when it comes up
        await lookAtCar(link.available);
        log.info('bre_hub ready (exhaust ' + (exhaust.armed ? 'armed' : 'simulated') + ', car ' + ident.model().code + ' by ' + ident.model().source + ')');
    },
});
