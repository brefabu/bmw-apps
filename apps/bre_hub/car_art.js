'use strict';
/**
 * car_art.js - the car on the first page, drawn from the side (facing left) with the kit's canvas.
 *
 * A shape is a set of outlines in millimetres (x from the front bumper, y up from the ground), taken from
 * the car's published dimensions: the G30 5 Series is 4936 long, 1479 high, 2975 between the axles. It is
 * our own drawing, not BMW's 3D model: the head unit does not give that to apps (docs/08).
 *
 *   const a = Art.draw(cv, t, { x, groundY, w, shape, paint, seat, flap, bg });
 *   a.seat / a.exhaust   where the driver's seat and the tailpipe are on the page (for the hot spots)
 */
const { withAlpha } = require('./kit/canvas');

// paint: base (the panels), light (what catches the light), dark (what is in shadow)
const PAINTS = {
    mineral: { name: 'Mineral Grey', base: '#5c6165', light: '#a9afb4', dark: '#2a2d30' },
    sapphire: { name: 'Black Sapphire', base: '#1c1e22', light: '#626871', dark: '#0a0b0d' },
    alpine: { name: 'Alpine White', base: '#d3d5d6', light: '#ffffff', dark: '#8b8e90' },
    phytonic: { name: 'Phytonic Blue', base: '#1e3b60', light: '#6187b5', dark: '#0d1b2e' },
    glacier: { name: 'Glacier Silver', base: '#a7acb0', light: '#e8ebed', dark: '#5b5f63' },
};
const DEFAULT_PAINT = 'mineral';

/** The top half of a wheel arch, from its rear end to its front end, cut off at height yCut. */
function arch(cx, cy, r, yCut, n) {
    const a0 = Math.asin((yCut - cy) / r), a1 = Math.PI - a0, pts = [];
    for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * i / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
}

const SEDAN = (() => {
    const length = 4936, height = 1479, front = 830, rear = 830 + 2975, wheelR = 340, archR = 400, sill = 200;
    // nose, bonnet, windscreen, roof, rear screen, boot lid, tail: front to rear
    const top = [[95, 185], [30, 250], [0, 380], [5, 560], [40, 660], [140, 720], [500, 800], [1000, 870], [1450, 925],
        [1620, 950], [1900, 1150], [2150, 1310], [2400, 1400], [2750, 1455], [3050, 1479], [3400, 1455], [3750, 1380],
        [4050, 1260], [4300, 1120], [4420, 1070], [4700, 1050], [4880, 1035], [4936, 990], [4930, 820], [4915, 620],
        [4900, 430], [4860, 300], [4760, 215]];
    const body = top.concat(arch(rear, wheelR, archR, sill, 14), arch(front, wheelR, archR, sill, 14));
    return {
        length, height, body,
        rim: top.slice(4, 22),                     // the edge the light runs along: bonnet to boot lid
        wheels: [front, rear], wheelR, archR,
        glass: [[1700, 985], [1960, 1150], [2200, 1300], [2430, 1375], [2780, 1420], [3080, 1434], [3400, 1414],
            [3720, 1345], [3960, 1245], [4070, 1150], [3990, 1050]],
        pillar: [[2900, 1012], [2962, 1014], [2978, 1430], [2916, 1426]],
        divider: [[3650, 1034], [3692, 1352]],
        crease: [[1150, 800], [2000, 835], [3000, 870], [4000, 905], [4780, 935]],
        seams: [
            [[1690, 965], [1722, 600], [1650, 240]],
            [[2936, 1012], [2936, 215]],
            [[3990, 1045], [3905, 800], [3560, 630], [3445, 420], [3432, 215]],
        ],
        handles: [[2620, 905], [3640, 932]],       // each 180 x 30
        mirror: [[1690, 985], [1700, 1060], [1800, 1085], [1890, 1070], [1900, 1000], [1800, 975]],
        headlight: [[35, 610], [70, 690], [300, 748], [470, 742], [360, 680], [140, 612]],
        headlightIn: [[120, 640], [330, 715], [420, 712], [330, 672], [160, 628]],
        taillight: [[4520, 990], [4905, 972], [4932, 940], [4928, 870], [4760, 885], [4600, 930]],
        taillightIn: [[4560, 966], [4900, 946]],
        breather: [[1290, 520], [1330, 520], [1370, 690], [1330, 690]],
        frontLow: [[95, 185], [30, 250], [10, 330], [430, 330], [455, 200]],
        rearLow: [[4180, 200], [4760, 215], [4860, 300], [4880, 340], [4200, 340]],
        sillBand: [1215, 3420, 200, 275],          // x0, x1, y0, y1
        tip: [4770, 4892, 232, 282],               // the tailpipe: x0, x1, y0, y1
        seatBase: [2330, 1000],                    // the driver's seat back at the belt line, seat fully forward
        seatSpot: [2480, 700],
        exhaustSpot: [5070, 300],
    };
})();
const SHAPES = { sedan: SEDAN };

function paintOf(id) { return PAINTS[id] || PAINTS[DEFAULT_PAINT]; }

function wheel(cv, cx, cy, r, s, spin) {
    cv.circle(cx, cy, r, '#101113');
    cv.arc(cx, cy, r * 0.9, r * 0.93, 0, 360, '#1d1f22');
    cv.circle(cx, cy, r * 0.72, '#1b1d20');
    cv.circle(cx, cy, r * 0.46, '#3a3d41');                      // the brake disc
    const w = Math.max(2, 17 * s);
    for (let k = 0; k < 5; k++) {
        for (let side = -1; side <= 1; side += 2) {
            const a0 = (k * 72 - 90 + spin) * Math.PI / 180, a1 = a0 + side * 0.15;
            cv.line(cx + Math.cos(a0) * r * 0.12, cy + Math.sin(a0) * r * 0.12,
                cx + Math.cos(a1) * r * 0.68, cy + Math.sin(a1) * r * 0.68, w, '#c2c6ca');
        }
    }
    cv.arc(cx, cy, r * 0.67, r * 0.73, 0, 360, '#d2d6da');
    cv.circle(cx, cy, r * 0.16, '#9a9fa4');
    cv.circle(cx, cy, r * 0.07, '#2a2c2f');
}

/**
 * Draw the car. o: { x, groundY, w (the car's length on the page), shape, paint, bg (the page behind it),
 * seat: { fore, height, back, moving }, flap: 'OPEN' | 'CLOSED' | 'OEM', accent, warn }.
 * Returns { seat: [x, y], exhaust: [x, y], top, h, s }.
 */
function draw(cv, t, o) {
    const sh = SHAPES[o.shape] || SEDAN, p = paintOf(o.paint), s = o.w / sh.length;
    const X = (x) => o.x + x * s, Y = (y) => o.groundY - y * s, R = (y) => o.groundY + y * s * 0.85;
    const P = (pts) => pts.map((q) => [X(q[0]), Y(q[1])]);
    const bg = o.bg || t.bg, px = (n) => Math.max(1, n);

    // the floor's reflection, fading out
    cv.fill(sh.body.map((q) => [X(q[0]), R(q[1])]), withAlpha(p.base, 0.2));
    sh.wheels.forEach((wx) => cv.circle(X(wx), R(sh.wheelR), sh.wheelR * s * 0.92, withAlpha('#000000', 0.5)));
    cv.gradientRect(o.x - 30, o.groundY, o.w + 60, sh.height * s * 0.85, [[0, withAlpha(bg, 0.25)], [0.7, bg], [1, bg]]);
    cv.roundRect(X(120), o.groundY - 2, sh.length * s - 240 * s, 5, 2.5, '#000000');

    // wheels in their arches
    sh.wheels.forEach((wx) => {
        cv.circle(X(wx), Y(sh.wheelR), sh.archR * s, '#040404');
        wheel(cv, X(wx), Y(sh.wheelR), sh.wheelR * s, s, wx === sh.wheels[0] ? 12 : 40);
    });

    // the body: paint, the dark low parts, the shade under the crease and the light above it
    cv.fill(P(sh.body), p.base);
    cv.fill(P(sh.frontLow), withAlpha(p.dark, 0.7));
    cv.fill(P(sh.rearLow), withAlpha(p.dark, 0.7));
    cv.fillRect(X(sh.sillBand[0]), Y(sh.sillBand[3]), (sh.sillBand[1] - sh.sillBand[0]) * s, (sh.sillBand[3] - sh.sillBand[2]) * s, withAlpha(p.dark, 0.85));
    const under = sh.crease.concat(sh.crease.slice().reverse().map((q) => [q[0], q[1] - 120]));
    const over = sh.crease.concat(sh.crease.slice().reverse().map((q) => [q[0], q[1] + 62]));
    const glint = sh.crease.map((q) => [q[0], q[1] + 30]).concat(sh.crease.slice().reverse().map((q) => [q[0], q[1] + 56]));
    cv.fill(P(under), withAlpha(p.dark, 0.5), true);
    cv.fill(P(over), withAlpha(p.light, 0.22), true);
    cv.fill(P(glint), withAlpha(p.light, 0.3), true);
    cv.polyline(P(sh.rim), px(1.5), withAlpha(p.light, 0.6));

    // glass, the seat behind it, pillars and the chrome round the windows
    cv.fill(P(sh.glass), '#0c1014');
    const st = o.seat || {}, fore = st.fore || 0, up = st.height || 0, back = st.back || 0;
    const sx = sh.seatBase[0] + fore * 300, sy = sh.seatBase[1] - 40 + up * 60;
    const lean = (8 + back * 22) * Math.PI / 180, len = 250, dx = Math.sin(lean), dy = Math.cos(lean);
    const seatC = st.moving ? (o.warn || t.warn) : '#39414b';
    cv.fill(P([[sx, sy], [sx + 75, sy], [sx + 75 + dx * len, sy + dy * len], [sx + dx * len, sy + dy * len]]), seatC);
    cv.roundRect(X(sx + dx * (len + 20) - 6), Y(sy + dy * (len + 20) + 95), 88 * s, 95 * s, 16 * s, seatC);
    cv.fill(P(sh.pillar), '#06070a');
    cv.polyline(P(sh.divider), px(34 * s), '#06070a');
    cv.polyline(P(sh.glass.concat([sh.glass[0]])), px(2), '#8d949b');

    // doors, handles, mirror, lamps
    sh.seams.forEach((line) => cv.polyline(P(line), px(1.5), withAlpha('#000000', 0.45)));
    sh.handles.forEach((h) => cv.roundRect(X(h[0]), Y(h[1] + 30), 180 * s, px(30 * s), px(8 * s), withAlpha(p.light, 0.55)));
    cv.fill(P(sh.mirror), p.dark);
    cv.fill(P(sh.breather), withAlpha('#000000', 0.6));
    cv.fill(P(sh.headlight), '#cfd8e3');
    cv.fill(P(sh.headlightIn), '#3a434e');
    cv.fill(P(sh.taillight), '#a81d18');
    cv.polyline(P(sh.taillightIn), px(2), '#ff5d4a');

    // the tailpipe, and the sound coming out of it while the flap is open
    const tp = sh.tip, tx = X(tp[1]), ty = Y((tp[2] + tp[3]) / 2);
    cv.roundRect(X(tp[0]), Y(tp[3]), (tp[1] - tp[0]) * s, (tp[3] - tp[2]) * s, 5 * s, '#b9bdc1');
    cv.roundRect(X(tp[1] - 34), Y(tp[3] - 8), 30 * s, (tp[3] - tp[2] - 16) * s, 3 * s, '#17181a');
    if (o.flap === 'OPEN' || o.flap === 'OEM') {
        const c = o.flap === 'OPEN' ? (o.accent || t.accent) : t.tick;
        for (let i = 1; i <= (o.flap === 'OPEN' ? 3 : 1); i++) {
            const r = (40 + i * 34) * s, wave = [];
            for (let a = -50; a <= 50; a += 10) wave.push([tx + Math.cos(a * Math.PI / 180) * r, ty + Math.sin(a * Math.PI / 180) * r]);
            cv.polyline(wave, px(2), withAlpha(c, 1 - i * 0.22));
        }
    }

    return { seat: [X(sh.seatSpot[0]), Y(sh.seatSpot[1])], exhaust: [X(sh.exhaustSpot[0]), Y(sh.exhaustSpot[1])],
        top: Y(sh.height), h: sh.height * s, s: s };
}

module.exports = { draw, PAINTS, DEFAULT_PAINT, SHAPES, paintOf };
