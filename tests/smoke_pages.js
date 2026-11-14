'use strict';
/**
 * Smoke test for BRE Hub's pages without the kit or a car: node tests/smoke_pages.js
 *
 * The pages' require('./kit/...') calls get small stand-ins (the real kit lives in kit/runtime and is
 * tested by its own repository). Each page is drawn with demo-like data, with missing data and while
 * moving, and every call it makes on the canvas is checked for bad numbers. It catches typos, wrong
 * arguments and NaN layouts; how a page looks is checked in the emulator (docs/10).
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

/* ---------- stand-ins for the kit ---------- */
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const calls = [];
function checkArgs(name, args) {
    args.forEach((a, i) => {
        if (typeof a === 'number') assert.ok(isFinite(a), name + ' argument ' + i + ' is ' + a);
    });
}
function canvas(own) {
    const cv = { w: 1600, h: 520, own: own, targets: [], runs: [] };
    ['fillRect', 'gradientRect', 'roundRect', 'strokeRoundRect', 'rampRect', 'arc', 'circle', 'line', 'polyline', 'quad',
        'fillUnder', 'clip', 'noclip', 'alpha', 'blit', 'image', 'clear', 'fill', 'convex', 'triangle', 'stroke'].forEach((m) => {
        cv[m] = function () { const a = Array.prototype.slice.call(arguments); checkArgs(m, a); calls.push(m); return cv; };
    });
    cv.text = function (str, x, y, size, c) {
        checkArgs('text', [x, y, size]);
        assert.ok(typeof str === 'string' && str.length, 'text needs a string, got ' + JSON.stringify(str));
        assert.ok(!/[ăâîșțĂÂÎȘȚ]/.test(str), 'diacritic reached the canvas: ' + str);
        calls.push('text'); return str.length * size * 0.5;
    };
    cv.textWidth = (str, size) => String(str).length * size * 0.5;
    cv.target = function (x, y, w, h, run, key) { checkArgs('target', [x, y, w, h]); assert.strictEqual(typeof run, 'function'); assert.ok(cv.targets.indexOf(key) < 0, 'two targets with the key ' + key); cv.targets.push(key); cv.runs.push(run); return cv; };
    return cv;
}
const gauges = {
    TOP: 44, BOTTOM: 512, isNum: isNum, clamp: clamp,
    pageBottom: (cv) => 512 + (cv.extra || 0),
    smooth: (k, v) => v,
    frame: (cv, t, tabs, sel) => { assert.ok(Array.isArray(tabs) && sel >= 0 && sel < tabs.length); tabs.forEach((x) => cv.text(x, 0, 25, 20, t.dim)); },
    button: (cv, t, x, y, w, h, label, run, o) => { checkArgs('button', [x, y, w, h]); if (cv.own && run && !(o && o.busy)) cv.target(x, y, w, h, run, (o && o.key) || label); cv.text(String(label), x, y, h * 0.4, t.text); return w; },
    pill: (cv, t, x, y, w, h, text) => { checkArgs('pill', [x, y, w, h]); cv.text(String(text), x, y, 18, t.text); return w; },
    radial: (cv, t, cx, cy, r, g) => { checkArgs('radial', [cx, cy, r, g.min, g.max, g.ticks]); assert.ok(cy - r >= 44 && cy + 0.71 * r <= 512, 'dial outside the page'); },
};
const kitThemes = { THEMES: {} };
const stubs = {
    gauges: gauges,
    canvas: { withAlpha: (c) => c },
    themes: kitThemes,
    record: { OP: { TRIS: 10, RECT: 1 } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent) {
    const m = /^\.\/kit\/(\w+)$/.exec(request);
    if (m && stubs[m[1]]) return 'kit-stub:' + m[1];
    return origResolve.apply(this, arguments);
};
Object.keys(stubs).forEach((k) => { require.cache['kit-stub:' + k] = { id: 'kit-stub:' + k, filename: k, loaded: true, exports: stubs[k] }; });

/* ---------- the app's shared state, as main.js builds it ---------- */
const fs = require('fs');
const app_dir = path.join(__dirname, '..', 'apps', 'bre_hub');
const D = require(path.join(app_dir, 'bre_design'));
const text = require(path.join(app_dir, 'bre_text'));
const S = require(path.join(app_dir, 'seats_backend'));
const { Exhaust } = require(path.join(app_dir, 'exhaust'));
const { CarIdent, MODELS, typeKey } = require(path.join(app_dir, 'car_ident'));
const Art = require(path.join(app_dir, 'car_art'));
const home = require(path.join(app_dir, 'page_home'));
const Picture = require(path.join(app_dir, 'car_picture'));
Picture.use([], {});          // the pages below draw the car themselves, whether or not photographs are packed

// the palettes join the kit's themes, so its header and focus ring are drawn in them (bre_design.js)
Object.keys(D.PALETTES).forEach((id) => {
    assert.strictEqual(kitThemes.THEMES['bre_' + id], D.PALETTES[id], 'palette ' + id + ' registered with the kit');
});
// app.json: the settings' choices are what the code knows
const spec = JSON.parse(fs.readFileSync(path.join(app_dir, 'app.json'), 'utf8'));
const setting = (key) => spec.settings.filter((s) => s.key === key)[0];
const choices = (key) => setting(key).options.map((o) => o[0]).sort();
assert.deepStrictEqual(choices('theme'), Object.keys(D.PALETTES).map((id) => 'bre_' + id).sort());
assert.deepStrictEqual(choices('paint'), Object.keys(Art.PAINTS).sort());
assert.deepStrictEqual(choices('carModel'), ['auto'].concat(Object.keys(MODELS)).sort());
assert.deepStrictEqual(choices('seatOffset'), home.OFFSETS.map(String).sort());
assert.strictEqual(setting('exhaustArm').default, 'off', 'the exhaust flap ships disarmed');
assert.strictEqual(setting('language').default, 'en');
assert.strictEqual(setting('demo').default, 'off', 'the car\'s own data by default, no simulated drive');
assert.deepStrictEqual(choices('demo'), ['off', 'on'], 'Demo is a switch: the kit\'s "auto" is not offered');
// the VIN gives only its type key
assert.strictEqual(typeKey('WBAJA51000G123456'), 'JA51');
assert.strictEqual(typeKey('too short'), null);

const quiet = { info() {}, warn() {}, error() {} };
const settingsValues = {};
spec.settings.forEach((s) => { settingsValues[s.key] = s.default; });
const settings = { get: (k) => settingsValues[k], set: (k, v) => { settingsValues[k] = v; } };
let moving = false, focused = null;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bre-smoke-'));
const seats = S.createBackend('demo', quiet);
const app = {
    settings: settings, log: quiet, parked: { moving: () => moving, speed: () => (moving ? 50 : 0) },
    seats: seats, positions: new S.Positions(tmp, quiet),
    exhaust: new Exhaust({ link: null, settings: settings, rpm: () => null, log: quiet }),
    ident: new CarIdent({ link: null, settings: settings, log: quiet, dataDir: tmp }),
    focusKey: () => focused, focus: (k) => { focused = k; }, openSettings: () => {},
};
app.easyEntry = new S.EasyEntry(seats, app.positions, quiet);
// the seat probe as seat_link.js leaves it: a module found, the seat moving back, its switch held
app.seatProbe = {
    state: 'found', reason: null, config: { slv: 2, shv: 2, lnv: 1 }, init: { initialised: true },
    hall: { slv: 30000, shv: 20000, lnv: null }, motor: { slv: 'minus', shv: 'off', lnv: null }, switches: { pressed: true },
    percent: (a) => (a === 'slv' ? 42 : null), resets: 0, resetTravel() { this.resets++; }, tick: () => Promise.resolve(),
    exitCounts: (offset) => (offset > 0 ? { slv: 32801, shv: 32473 } : null),
};
assert.strictEqual(app.ident.model().code, 'G30');

const datas = {
    'demo drive': { rpm: 3120, speed: 87.4, demo: true },
    'parked': { rpm: 820, speed: 0, demo: false },
    'no data': { rpm: null, speed: null, demo: false },
};

/** Draw the page; with press, run that target first (as the controller would) and draw again. */
function drawPage(own, data, press) {
    const t = D.theme({ settings: settings });
    let cv = canvas(own);
    home.draw(cv, t, app, data);
    if (press) {
        const i = cv.targets.indexOf(press);
        assert.ok(i >= 0, 'no target ' + press + ' among ' + cv.targets.join(' '));
        cv.runs[i]();
        cv = canvas(own);
        home.draw(cv, t, app, data);
    }
    return cv;
}

let n = 0;
['en', 'ro'].forEach((lang) => {
    text.setLanguage(lang);
    ['bre_idrive', 'bre_graphite', 'bre_sand'].forEach((th) => {
        settingsValues.theme = th;
        assert.strictEqual(D.theme({ settings: settings }), D.PALETTES[th.slice(4)], 'theme ' + th);
        Object.keys(Art.PAINTS).forEach((paint) => {
            settingsValues.paint = paint;
            [true, false].forEach((own) => {
                [false, true].forEach((mv) => {
                    moving = mv;
                    Object.keys(datas).forEach((k) => {
                        ['main', 'seat', 'seatinfo', 'exhaust', 'modes', 'paint'].forEach((view) => {
                            home.ui.view = view; home.ui.open = true; home.ui.k = 1;
                            try { drawPage(own, datas[k]); } catch (e) { e.message = view + ' / ' + k + ' / ' + lang + ': ' + e.message; throw e; }
                            n++;
                        });
                        home.ui.open = false; home.ui.k = 0;                    // the list folded away
                        const cv = drawPage(own, datas[k]);
                        if (own) assert.deepStrictEqual(cv.targets.slice().sort(), ['demo', 'grip', 'spot-exhaust', 'spot-seat'], 'folded: the car, the grip and the Demo switch');
                        n++;
                    });
                });
            });
        });
    });
});

// the list, by the controller: every row does what it says (simulated: the exhaust is disarmed)
text.setLanguage('en'); moving = false;
const D0 = datas.parked;
home.ui.view = 'main'; home.ui.open = true; home.ui.k = 1;
let cv = drawPage(true, D0);
assert.deepStrictEqual(cv.targets.filter((k) => /^main-/.test(k)), ['main-seat', 'main-exhaust', 'main-paint', 'main-settings']);
// the Demo switch, top right: on, off again
assert.strictEqual(cv.targets[cv.targets.length - 1], 'demo', 'the Demo switch is the controller\'s last stop');
drawPage(true, D0, 'demo');
assert.strictEqual(settingsValues.demo, 'on', 'Demo switched on');
drawPage(true, D0, 'demo');
assert.strictEqual(settingsValues.demo, 'off', 'Demo switched off');
drawPage(true, D0, 'main-paint');
assert.strictEqual(home.ui.view, 'paint');
drawPage(true, D0, 'paint-bernina');
assert.strictEqual(settingsValues.paint, 'bernina', 'the paint list sets the colour');
drawPage(true, D0, 'paint-back');
assert.strictEqual(home.ui.view, 'main');
drawPage(true, D0, 'spot-exhaust');
assert.strictEqual(home.ui.view, 'exhaust', 'the tailpipe hot spot opens the exhaust list');
drawPage(true, D0, 'ex-open');
assert.strictEqual(app.exhaust.selected(), 'OPEN');
drawPage(true, D0, 'ex-drive');
assert.strictEqual(settingsValues.exhaustDrive, 'on');
drawPage(true, D0, 'ex-hold');
assert.strictEqual(settingsValues.exhaustHold, 'off');
drawPage(true, D0, 'ex-modes');
assert.strictEqual(home.ui.view, 'modes');
drawPage(true, D0, 'mode-sport');
assert.strictEqual(settingsValues.exhaustSport, 'closed', 'a press steps Sport from Open to Closed');
drawPage(true, D0, 'mode-back');
drawPage(true, D0, 'ex-auto');
assert.strictEqual(app.exhaust.selected(), 'OEM');
drawPage(true, D0, 'ex-back');
drawPage(true, D0, 'spot-seat');
assert.strictEqual(home.ui.view, 'seat', 'the seat hot spot opens the seat list');
drawPage(true, D0, 'seat-more');
assert.strictEqual(settingsValues.seatOffset, '80');
drawPage(true, D0, 'seat-less');
drawPage(true, D0, 'seat-less');
assert.strictEqual(settingsValues.seatOffset, '70');
drawPage(true, D0, 'seat-try');
assert.strictEqual(app.easyEntry.state, 'MOVING_OUT', 'Try: get out starts the move');
drawPage(true, D0, 'seat-try');
assert.strictEqual(app.easyEntry.state, 'STOPPED', 'the same row is Stop while it moves');
drawPage(true, D0, 'seat-try');
assert.strictEqual(app.easyEntry.state, 'IDLE');
// position 1 can be saved from the seat list
cv = drawPage(true, D0);
assert.ok(cv.targets.indexOf('seat-save') >= 0, 'Save as position 1 is a target');
// the seat probe's list: read only, back to the seat list
drawPage(true, D0, 'seat-module');
assert.strictEqual(home.ui.view, 'seatinfo', 'Seat module opens the probe');
cv = drawPage(true, D0);
assert.deepStrictEqual(cv.targets.filter((k) => /^probe-/.test(k)), ['probe-back', 'probe-reset'], 'only Back and Measure again can be pressed');
drawPage(true, D0, 'probe-reset');
assert.strictEqual(app.seatProbe.resets, 1);
app.seatProbe.state = 'none'; app.seatProbe.reason = 'timeout';
drawPage(true, D0);
app.seatProbe.state = 'found';
drawPage(true, D0, 'probe-back');
assert.strictEqual(home.ui.view, 'seat');
// armed (the real seat): the list says so, a stop shows why; turning it off from the page never arms it again
settingsValues.easyEntry = 'armed';
app.seats.reason = () => 'a seat switch was touched';
app.easyEntry.state = 'STOPPED';
drawPage(true, D0);
app.easyEntry.state = 'IDLE';
delete app.seats.reason;
home.ui.view = 'main';
assert.ok(drawPage(true, D0).targets.indexOf('main-seat') >= 0);
home.ui.view = 'seat';
drawPage(true, D0, 'seat-on');
assert.strictEqual(settingsValues.easyEntry, 'off', 'the page turns armed off');
drawPage(true, D0, 'seat-on');
assert.strictEqual(settingsValues.easyEntry, 'demo', 'and on again only as the demo');
drawPage(true, D0, 'seat-on');
assert.strictEqual(settingsValues.easyEntry, 'off');
cv = drawPage(true, D0);
assert.ok(cv.targets.indexOf('seat-try') < 0, 'off: nothing to try');
moving = true;
settingsValues.easyEntry = 'demo';
cv = drawPage(true, D0);
assert.ok(cv.targets.indexOf('seat-try') < 0, 'driving: the seat is not moved');
drawPage(true, D0, 'grip');
assert.strictEqual(home.ui.open, false);

// the car as photographs (car_picture.js), one per paint, here two cells each: drawn as a layer
const zlib = require('zlib');
const photoOf = (grey) => {
    const cellData = Buffer.alloc(12 + 25);
    [0, 0, 4, 2].forEach((v, i) => cellData.writeUInt16LE(v, i * 2));            // flat cell: x, y, w, h
    cellData.writeUInt32BE(((grey << 24) | (grey << 16) | (grey << 8) | 255) >>> 0, 8);
    [0, 2, 4, 2].forEach((v, i) => cellData.writeUInt16LE(v, 12 + i * 2));       // shaded cell, dark to light
    cellData[20] = 0;
    [0x202020ff, 0x808080ff, 0x202020ff, 0x808080ff].forEach((v, i) => cellData.writeUInt32BE(v, 21 + i * 4));
    return { LW: 4, LH: 4, DW: 4, DH: 4, K: 1, NF: 1, NT: 1, ground: 3, seat: [1, 1], exhaust: [4, 2], data: zlib.deflateSync(cellData).toString('base64') };
};
Picture.use([{ id: 'mineral', name: 'Mineral Grey' }, { id: 'alpine', name: 'Alpine White' }], { mineral: photoOf(0x40), alpine: photoOf(0xe0) });
assert.deepStrictEqual(Picture.list().map((e) => e.id), ['mineral', 'alpine']);
assert.ok(Picture.available('alpine') && !Picture.available('carbon') && !Picture.available('../x'));
let px = Picture.pixels('mineral');
assert.deepStrictEqual([px.w, px.h, px.d[0], px.d[3]], [4, 4, 0x40, 255], 'as photographed');
assert.ok(px.d[(2 * 4 + 0) * 4] < px.d[(2 * 4 + 3) * 4], 'the shaded cell runs from dark to light');
assert.strictEqual(Picture.pixels('alpine').d[0], 0xe0, 'each paint is its own photograph');
const layers = {};
gauges.layer = (key, w, h, draw) => layers[key] || (layers[key] = (draw(canvas(true)), { layerId: Object.keys(layers).length + 1, w: w, h: h }));
moving = false; home.ui.view = 'main'; home.ui.open = true; home.ui.k = 1;
settingsValues.paint = 'mineral';
const before = calls.length;
cv = drawPage(true, D0);
assert.ok(calls.slice(before).indexOf('blit') >= 0, 'the photograph is drawn as a layer');
assert.ok(cv.targets.indexOf('spot-seat') >= 0 && cv.targets.indexOf('spot-exhaust') >= 0, 'with its hot spots');
settingsValues.paint = 'alpine';
drawPage(true, D0);
assert.deepStrictEqual(Object.keys(layers).sort(), ['bre_car_picture|alpine', 'bre_car_picture|mineral'], 'a layer for each paint shown');
settingsValues.paint = 'carbon';                 // no photograph of it: the drawing
const nb = calls.length;
cv = drawPage(true, D0);
assert.ok(calls.slice(nb).indexOf('blit') < 0 && cv.targets.indexOf('spot-seat') >= 0, 'a paint without a photograph is drawn');
delete gauges.layer;
Picture.use([], {});

app.exhaust.close();
seats.close();
console.log('ok - ' + n + ' page draws, ' + calls.length + ' canvas calls, the list driven by its targets, no bad numbers or diacritics');
