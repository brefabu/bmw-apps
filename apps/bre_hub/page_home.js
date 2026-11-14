'use strict';
/**
 * page_home.js - BRE Hub's one page, laid out like iDrive 7's My Vehicle: a list on the left that folds away
 * on its grip, the car on the right with a hot spot on the driver's seat and one at the tailpipe. The car is the
 * photograph of the paint chosen in the list when it is packed with the app (car_picture.js), else our drawing of
 * it in that paint (car_art.js).
 *
 *   list 'main'     Seat Easy Access, Exhaust flap, Paint, Settings
 *   list 'seat'     Easy Access on / off, how far back the seat goes, try it (the demo), Stop
 *   list 'exhaust'  Open / Closed / Auto / By driving mode, Driving modes, Hold
 *   list 'modes'    the flap for the Sport, Comfort and Eco Pro driving modes (a press steps to the next)
 *   list 'paint'    the car's colour in the picture (the "paint" setting)
 * A hot spot opens its list. Nothing here moves a seat or the flap itself: the seat goes through
 * app.easyEntry (seats_backend.js, demo only, docs/07), the flap through app.exhaust (exhaust.js).
 */
const G = require('./kit/gauges');
const D = require('./bre_design');
const Art = require('./car_art');
const Picture = require('./car_picture');
const { T } = require('./bre_text');

// the list starts PANEL_X in: the HMI's back column covers the page's first few units (kit/runtime/display.js)
const PANEL_X = 12, PANEL_W = 500, GRIP_W = 22, ROW_H = 62;
const OFFSETS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];      // the "seatOffset" setting's values
const FLAPS = ['open', 'closed', 'oem'];                             // a driving mode group's setting, in press order
const FLAP_TEXT = { OPEN: 'ex.open', CLOSED: 'ex.closed', OEM: 'ex.auto', DRIVE: 'ex.drive' };

const ui = { view: 'main', open: true, k: 1 };

/** Open list v (and unfold the list); focus: the row the controller goes to. */
function show(app, v, focus) {
    ui.view = v; ui.open = true;
    if (app.focus && focus) app.focus(focus);
}

function offsetOf(app) {
    const v = Number(app.settings.get('seatOffset'));
    return isFinite(v) && v > 0 ? v : 75;
}
function stepOffset(app, d) {
    const i = OFFSETS.indexOf(offsetOf(app));
    const n = OFFSETS[Math.max(0, Math.min(OFFSETS.length - 1, (i < 0 ? OFFSETS.indexOf(75) : i) + d))];
    app.settings.set('seatOffset', String(n));
}
function groupFlap(app, key) {
    const v = String(app.settings.get(key) || '').toUpperCase();
    return FLAP_TEXT[v] ? v : null;
}

/** The rows of the list shown: what listRow takes, plus foot (a line under the rows: { text, warn }). */
function rows(app, parked) {
    const s = app.settings, ee = app.easyEntry, ex = app.exhaust.view(), mode = s.get('easyEntry');
    const on = mode !== 'off';
    if (ui.view === 'seat') {
        const moving = ee.state === 'MOVING_OUT' || ee.state === 'MOVING_IN';
        const tryKey = moving ? 'seats.stop' : ee.state === 'OUT' ? 'seats.tryIn' : ee.state === 'STOPPED' ? 'seats.reset' : 'seats.tryOut';
        const tryRun = () => {
            if (moving) { ee.manual(); app.seats.stop('driver'); }
            else if (ee.state === 'STOPPED') ee.reset();
            else if (ee.state === 'OUT') ee.onCar({ doorOpen: false, ignition: true, parked: parked }, mode);
            else {
                ee.onCar({ doorOpen: false, ignition: true, parked: parked }, mode);       // (a fresh door opening)
                ee.onCar({ doorOpen: true, ignition: false, parked: parked }, mode);
            }
        };
        return {
            list: [
                { key: 'seat-back', icon: 'back', label: T('menu.seat'), run: () => show(app, 'main', 'main-seat') },
                { key: 'seat-on', label: T('seats.easy'), check: on, run: () => s.set('easyEntry', on ? 'off' : 'demo') },
                { key: 'seat-less', label: T('seats.offset'), value: offsetOf(app) + ' %', stepper: true,
                    less: () => stepOffset(app, -1), more: () => stepOffset(app, 1) },
                { key: 'seat-try', label: T(tryKey), color: moving ? 'crit' : null, dim: !on || (!parked && !moving), run: tryRun },
            ],
            foot: !parked ? { text: T('seats.parkedOnly'), warn: true } : on ? { text: T('state.' + ee.state) + ' · ' + T('seats.demo') } : null,
        };
    }
    if (ui.view === 'exhaust') {
        const pick = (m) => () => app.exhaust.press(m);
        return {
            list: [
                { key: 'ex-back', icon: 'back', label: T('menu.exhaust'), run: () => show(app, 'main', 'main-exhaust') },
                { key: 'ex-open', label: T('ex.open'), tick: ex.selected === 'OPEN', run: pick('OPEN') },
                { key: 'ex-closed', label: T('ex.closed'), tick: ex.selected === 'CLOSED', run: pick('CLOSED') },
                { key: 'ex-auto', label: T('ex.auto'), tick: ex.selected === 'OEM', run: pick('OEM') },
                { key: 'ex-drive', label: T('ex.drive'), tick: ex.selected === 'DRIVE',
                    value: ex.selected === 'DRIVE' && ex.group ? T('group.' + ex.group) : null, run: pick('DRIVE') },
                { key: 'ex-modes', label: T('ex.modes'), next: true, run: () => show(app, 'modes', 'mode-sport') },
                { key: 'ex-hold', label: T('ex.hold'), value: T('ex.holdValue'), check: ex.holdOn,
                    run: () => s.set('exhaustHold', ex.holdOn ? 'off' : 'on') },
            ],
            foot: ex.note ? { text: T(ex.note.key, ex.note.vars), warn: ex.note.warn } : null,
        };
    }
    if (ui.view === 'modes') {
        const row = (group, key) => {
            const now = groupFlap(app, key) || 'OEM';
            return { key: 'mode-' + group, label: T('group.' + group), value: T(FLAP_TEXT[now]),
                run: () => s.set(key, FLAPS[(FLAPS.indexOf(now.toLowerCase()) + 1) % FLAPS.length]) };
        };
        return {
            list: [
                { key: 'mode-back', icon: 'back', label: T('ex.modes'), run: () => show(app, 'exhaust', 'ex-modes') },
                row('sport', 'exhaustSport'), row('comfort', 'exhaustComfort'), row('eco', 'exhaustEco'),
            ],
            foot: ex.note ? { text: T(ex.note.key, ex.note.vars), warn: ex.note.warn } : null,
        };
    }
    if (ui.view === 'paint') {
        const now = Art.PAINTS[s.get('paint')] ? s.get('paint') : Art.DEFAULT_PAINT;
        return {
            list: [{ key: 'paint-back', icon: 'back', label: T('menu.paint'), run: () => show(app, 'main', 'main-paint') }]
                .concat(Object.keys(Art.PAINTS).map((id) => ({ key: 'paint-' + id, label: Art.PAINTS[id].name, swatch: Art.PAINTS[id].base,
                    tick: id === now, run: () => s.set('paint', id) }))),
            foot: null,
        };
    }
    return {
        list: [
            { key: 'main-seat', icon: 'seat', label: T('menu.seat'), value: T(on ? 'on' : 'off'), next: true, run: () => show(app, 'seat', 'seat-on') },
            { key: 'main-exhaust', icon: 'exhaust', label: T('menu.exhaust'), value: T(FLAP_TEXT[ex.selected] || 'ex.auto'), next: true,
                run: () => show(app, 'exhaust', 'ex-open') },
            { key: 'main-paint', icon: 'paint', label: T('menu.paint'), value: Art.paintOf(s.get('paint')).name, next: true,
                run: () => show(app, 'paint', 'paint-' + (Art.PAINTS[s.get('paint')] ? s.get('paint') : Art.DEFAULT_PAINT)) },
            { key: 'main-settings', icon: 'gear', label: T('menu.settings'), next: true, run: () => app.openSettings() },
        ],
        foot: null,
    };
}

function drawList(cv, t, app, x, y, w, h, parked) {
    cv.gradientRect(x, y, w, h, [[0, t.panelTop], [1, t.panelBottom]]);
    D.tileLine(cv, t, x, y, w);
    cv.fillRect(x + w - 1, y, 1, h, t.panelEdge);
    const m = rows(app, parked), focus = app.focusKey ? app.focusKey() : null;
    let ry = y + D.LINE.leadH + 3;
    m.list.forEach((row) => {
        const r = { x: x, y: ry, w: w - 1, h: ROW_H };
        const o = Object.assign({}, row, { focus: focus === row.key, color: row.color ? D.stateColor(t, row.color) : null });
        if (row.stepper) {
            // the value with a - and a + beside it: two places for the controller
            const bw = 56, bx = x + w - 1 - D.SPACE.s - 2 * bw - D.SPACE.xs;
            D.listRow(cv, t, { x: x, y: ry, w: bx - x - D.SPACE.xs, h: ROW_H }, Object.assign({}, o, { run: null, focus: false }));
            cv.fillRect(bx - D.SPACE.xs, ry + ROW_H - 1, w - (bx - D.SPACE.xs - x) - D.SPACE.xs, 1, t.panelEdge);
            D.button(cv, t, bx, ry + 8, bw, ROW_H - 16, '-', row.less, { key: row.key });
            D.button(cv, t, bx + bw + D.SPACE.xs, ry + 8, bw, ROW_H - 16, '+', row.more, { key: row.key.replace('less', 'more') });
        } else D.listRow(cv, t, r, o);
        ry += ROW_H;
    });
    if (m.foot && ry + 40 < y + h) {
        cv.text(m.foot.text, x + D.SPACE.m, ry + 34, D.TYPE.caption.size, m.foot.warn ? t.warn : t.dim, { font: D.TYPE.caption.font });
    }
}

function draw(cv, t, app, d) {
    const top = G.TOP, bottom = G.pageBottom(cv), h = bottom - top;
    const parked = !app.parked.moving();
    ui.k += ((ui.open ? 1 : 0) - ui.k) * 0.3;
    if (Math.abs((ui.open ? 1 : 0) - ui.k) < 0.01) ui.k = ui.open ? 1 : 0;
    const pw = Math.round(PANEL_W * ui.k), px = PANEL_X + pw;

    // the list and its grip first: the controller's first turn lands on the list's first row
    if (pw > 2) {
        cv.clip(PANEL_X, top, pw, h);
        drawList(cv, t, app, px - PANEL_W, top, PANEL_W, h, parked);
        cv.noclip();
    }
    D.grip(cv, t, px, top, h, () => { ui.open = !ui.open; }, 'grip');

    // the car, in what the list leaves free
    const ax = px + GRIP_W, aw = D.W - ax;
    const model = app.ident.model(), paint = Art.paintOf(app.settings.get('paint'));
    const groundY = top + Math.round(h * 0.7);
    cv.gradientRect(ax, groundY, aw, bottom - groundY, [[0, '#191919'], [0.6, t.bg], [1, t.bg]]);
    const seat = app.seats.status().seats.driver, ex = app.exhaust.view();
    const paintId = Art.PAINTS[app.settings.get('paint')] ? app.settings.get('paint') : Art.DEFAULT_PAINT;
    const pic = Picture.info(paintId);
    let car = null;
    if (pic) {
        // the photograph, at its own size (its cells sit on the screen's pixels)
        const x = ax + Math.round((aw - pic.LW) / 2) - 16, y = groundY - Math.round(pic.ground);
        if (Picture.blit(cv, G, x, y, paintId)) {
            const tx = x + pic.exhaust[0] - 14, ty = y + pic.exhaust[1];
            Art.waves(cv, t, tx, ty, 0.17, ex.effective);
            car = { seat: [x + pic.seat[0], y + pic.seat[1]], exhaust: [tx + 44, ty] };
        }
    }
    if (!car) {
        const w = Math.min(1000, aw - 220);
        car = Art.draw(cv, t, {
            x: ax + Math.round((aw - w) / 2) - 12, groundY: groundY, w: w, shape: model.shape, paint: paintId,
            bg: t.bg, seat: { fore: seat.pos.fore, height: seat.pos.height, back: seat.pos.back, moving: seat.moving },
            flap: ex.effective,
        });
    }
    const focus = app.focusKey ? app.focusKey() : null;
    D.hotspot(cv, t, car.seat[0], car.seat[1], { key: 'spot-seat', on: ui.view === 'seat' || focus === 'spot-seat', run: () => show(app, 'seat', 'seat-on') });
    D.hotspot(cv, t, car.exhaust[0], car.exhaust[1], { key: 'spot-exhaust', on: ui.view === 'exhaust' || ui.view === 'modes' || focus === 'spot-exhaust',
        run: () => show(app, 'exhaust', 'ex-open') });

    // which car it is, under it
    const cx = ax + aw / 2;
    cv.text(model.name, cx, bottom - 44, D.TYPE.body.size, t.text, { font: D.TYPE.body.font, align: 'center' });
    cv.text(model.code + ' ' + model.body + ' · ' + paint.name + (model.source === 'car' ? ' · ' + T('car.fromCar') : ''),
        cx, bottom - 18, D.TYPE.caption.size, t.dim, { font: D.TYPE.caption.font, align: 'center' });

    // status, top right: Parked is on or off; Demo while the numbers are not the car's
    let x = D.W - D.MARGIN;
    const chips = [[T(parked ? 'chip.parked' : 'chip.moving'), parked ? 'on' : 'off']];
    if (d.demo) chips.push([T('chip.demo'), 'accent']);
    chips.forEach((c) => {
        x -= D.chipWidth(cv, c[0]);
        D.chip(cv, t, x, top + D.SPACE.s, c[0], c[1]);
        x -= D.SPACE.xs;
    });
}

module.exports = { id: 'home', draw, ui, OFFSETS };
