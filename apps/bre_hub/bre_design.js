'use strict';
/**
 * bre_design.js - the BRE design system (docs/08) on top of the idrive7-apps kit.
 *
 * The look is BMW Operating System 7.0 (iDrive 7), measured on BMW's own renders of the display (docs/08):
 * a black ground, flat square tiles marked by a line along their top (a short white lead with a slanted end,
 * then a hairline), white type in regular weights, light figures, and one orange accent for what is selected.
 *
 * Tokens: palettes (complete kit themes, so every G.* template works with them; registered with the kit so
 * its header, tabs and controller focus are drawn in them too), the grid, spacing, radii and the baked type
 * sizes. Components draw with the kit's Recorder `cv` (ctx.canvas) and take the palette `t`.
 * Node 8: no ?. / ?? / object spread.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const kitThemes = require('./kit/themes');

const W = 1600, H = 520;            // the page the kit scales onto the 1920 x 720 screen
const MARGIN = 24, GUTTER = 16, COLS = 4;
const COL_W = (W - 2 * MARGIN - (COLS - 1) * GUTTER) / COLS;     // 376
const SPACE = { xs: 8, s: 16, m: 24, l: 32, xl: 48 };
const RADIUS = { card: 0, control: 0 };                          // iDrive 7: square corners everywhere
// a tile's top line: the white lead (length, height, how far its right end slants back), then the hairline
const LINE = { lead: 96, leadH: 5, slant: 10, hair: 2 };
// sizes baked into the kit's atlases (kit/tools/bake_fonts.py): use only these
const TYPE = {
    display: { font: 'light', size: 110 },   // digits and a few letters only (P R N D, units)
    big: { font: 'light', size: 64 },
    title: { font: 'label', size: 44 },
    heading: { font: 'label', size: 32 },
    body: { font: 'label', size: 24 },
    caption: { font: 'label', size: 18 },
    soft: { font: 'light', size: 32 },
    tag: { font: 'bold', size: 18 },         // the word in a status chip
};

// Every key of a kit theme (kit/runtime/themes.js) is set, so G.panel, G.radial, G.frame ... draw in our
// colours. The keys after the kit's are ours: lead (a tile's white lead), raised / raisedBottom (a button),
// focusTop / focusBottom (the warm fill under a chosen item, iDrive 7's selection), figure (the seat drawing).
const PALETTES = {
    // measured on BMW's 1920 x 720 render of the My Vehicle menu (P90324489): ground #000000, list rows
    // #191919 to #212121, separators #5e5e5e, text #ffffff, the selection a #2a170d..#461e16 fill over a
    // #f84503 line
    idrive: {
        name: 'iDrive 7',
        bg: '#000000', panelTop: '#191919', panelBottom: '#212121', panelEdge: '#5e5e5e',
        tab: '#ffffff', track: '#2e2e2e', tick: '#5e5e5e', text: '#ffffff', dim: '#a3a3a3',
        accent: '#f84503', accent2: '#ff8a4d', ok: '#5cc77f', warn: '#f5a623', crit: '#e8251f', cold: '#5aa9e6',
        glow: '#f8450340', stripes: ['#f84503'], oil: '#ff8a4d', bar: '#f84503', hang: '#ff8a4d',
        sel: '#f84503', selText: '#ffffff', marker: '#ffffff',
        ramp: ['#5e5e5e', '#c8c8c8', '#ffffff'], hotRamp: ['#5e5e5e', '#c8c8c8', '#ffffff', '#ff8a4d', '#f84503'],
        lead: '#d6d6d6', raised: '#2a2a2a', raisedBottom: '#1f1f1f', focusTop: '#2a170d', focusBottom: '#461e16',
        figure: '#c4c4c4',
    },
    graphite: {
        name: 'Graphite',
        bg: '#0a0c0f', panelTop: '#171b21', panelBottom: '#101317', panelEdge: '#242a33',
        tab: '#e9edf2', track: '#1d232b', tick: '#4a5361', text: '#f2f4f7', dim: '#94a0ae',
        accent: '#4c9be8', accent2: '#9ccaf5', ok: '#4fc98b', warn: '#f5a94a', crit: '#ef5350', cold: '#6fb6f5',
        glow: '#4c9be840', stripes: ['#4c9be8'], oil: '#f08a5d', bar: '#4c9be8', hang: '#9ccaf5',
        sel: '#4c9be8', selText: '#ffffff', marker: '#f2f4f7',
        ramp: ['#24496e', '#4c9be8', '#bfe0ff'], hotRamp: ['#24496e', '#4c9be8', '#4c9be8', '#f5a94a', '#ef5350'],
        lead: '#d9e2ec', raised: '#1f252e', raisedBottom: '#181c23', focusTop: '#15263a', focusBottom: '#1f3b5a',
        figure: '#4c9be8',
    },
    sand: {
        name: 'Sand',
        bg: '#0d0b09', panelTop: '#1c1915', panelBottom: '#13110e', panelEdge: '#2f2a23',
        tab: '#f6efe6', track: '#25211c', tick: '#5e554a', text: '#f6efe6', dim: '#a89c8c',
        accent: '#d9a46c', accent2: '#f0cfa8', ok: '#7cc79a', warn: '#f0b45a', crit: '#e8644f', cold: '#8bb8d8',
        glow: '#d9a46c40', stripes: ['#d9a46c'], oil: '#e8644f', bar: '#d9a46c', hang: '#f0cfa8',
        sel: '#d9a46c', selText: '#1a120a', marker: '#f6efe6',
        ramp: ['#6b4e30', '#d9a46c', '#f6e2c8'], hotRamp: ['#6b4e30', '#d9a46c', '#d9a46c', '#f0b45a', '#e8644f'],
        lead: '#f0e2cf', raised: '#27231e', raisedBottom: '#1e1b17', focusTop: '#2e2114', focusBottom: '#4a3520',
        figure: '#d9a46c',
    },
};

// The kit draws its own parts of the screen (the header and its tabs, the controller's focus ring) in the
// theme its "theme" setting names (kit/runtime/mgu.js, themes.theme). Our palettes join the kit's list as
// bre_<id>, so app.json's "theme" setting picks one palette for the whole screen.
Object.keys(PALETTES).forEach((id) => { kitThemes.THEMES['bre_' + id] = PALETTES[id]; });

/** The palette for this frame: the app's "theme" setting (bre_<id>), else iDrive 7. */
function theme(ctx) {
    const id = ctx && ctx.settings ? String(ctx.settings.get('theme') || '') : '';
    return PALETTES[id.replace(/^bre_/, '')] || PALETTES.idrive;
}

/** The rectangle of grid columns [i, i + n) between y and y + h. */
function col(i, n, y, h) {
    return { x: MARGIN + i * (COL_W + GUTTER), y: y, w: n * COL_W + (n - 1) * GUTTER, h: h };
}

/** A state name ('ok' | 'warn' | 'crit' | 'cold' | 'dim' | 'accent') to a palette colour. */
function stateColor(t, state) {
    if (state === 'ok') return t.ok;
    if (state === 'warn') return t.warn;
    if (state === 'crit') return t.crit;
    if (state === 'cold') return t.cold;
    if (state === 'accent') return t.accent;
    if (state === 'dim') return t.dim;
    return t.text;
}

/** The iDrive 7 tile mark along the top edge at x, y, w wide: the white lead, then the hairline. */
function tileLine(cv, t, x, y, w) {
    const lead = Math.min(LINE.lead, w * 0.4);
    cv.fillRect(x + lead, y, w - lead, LINE.hair, t.panelEdge);
    cv.quad([[x, y], [x + lead, y], [x + lead - LINE.slant, y + LINE.leadH], [x, y + LINE.leadH]], t.lead);
}

/** The base surface: a flat square tile with the iDrive 7 top line and an optional title. Returns the inner rect. */
function card(cv, t, r, opts) {
    const o = opts || {};
    cv.gradientRect(r.x, r.y, r.w, r.h, o.focus ? [[0, t.focusTop], [1, t.focusBottom]] : [[0, t.panelTop], [1, t.panelBottom]]);
    tileLine(cv, t, r.x, r.y, r.w);
    let top = r.y + SPACE.m;
    if (o.title) {
        cv.text(o.title, r.x + SPACE.m, r.y + SPACE.m + 26, TYPE.body.size, t.text, { font: TYPE.body.font });
        top = r.y + SPACE.m + 42;
    }
    if (o.run && cv.own && cv.target) cv.target(r.x, r.y, r.w, r.h, o.run, o.key || o.title || 'card', RADIUS.card);
    return { x: r.x + SPACE.m, y: top, w: r.w - 2 * SPACE.m, h: r.y + r.h - SPACE.m - top };
}

/** One value, large: { label, value, unit, state, sub }. value null -> '--'. */
function metric(cv, t, r, m) {
    const inner = card(cv, t, r, { title: m.label, run: m.run, key: m.key });
    const hasValue = m.value !== null && m.value !== undefined && m.value !== '';
    const text = hasValue ? String(m.value) : '--';
    const color = hasValue ? stateColor(t, m.state) : t.dim;
    const type = r.h >= 200 ? TYPE.display : TYPE.big;
    const base = inner.y + type.size * 0.78;
    const w = cv.text(text, inner.x, base, type.size, color, { font: type.font });
    if (m.unit) cv.text(m.unit, inner.x + w + SPACE.xs, base, TYPE.body.size, t.dim);
    if (m.sub) cv.text(m.sub, inner.x, Math.min(r.y + r.h - SPACE.m, base + 40), TYPE.caption.size, t.dim);
}

/** A page title and its line under it, top left of the content area. */
function title(cv, t, x, y, text, sub) {
    cv.text(text, x, y + 40, TYPE.title.size, t.text, { font: TYPE.title.font });
    if (sub) cv.text(sub, x, y + 76, TYPE.body.size, t.dim);
}

// confirm buttons pressed once: key -> when; a second press within CONFIRM_MS runs them
const armed = {};
const CONFIRM_MS = 5000;

/**
 * A button on the page, iDrive 7 style: a flat raised rectangle; primary (the chosen one) wears the selection,
 * the warm fill over the accent line. opts: { key (default: the label), color (a warning colour: its text and
 * line), primary, busy (drawn dimmed, nothing to press), confirm (the first press asks, a second within 5 s
 * runs it) }. The kit draws the controller's focus round it (cv.target). Returns the button's width.
 */
function button(cv, t, x, y, w, h, label, run, opts) {
    let o = opts || {};
    if (!cv.own) return 0;              // without the GPU renderer the HMI's own bar has the buttons
    const key = o.key || String(label);
    let text = String(label), act = run;
    if (o.confirm && run) {
        const live = () => armed[key] && Date.now() - armed[key] < CONFIRM_MS;
        if (live()) { text = 'Confirm'; o = Object.assign({}, o, { color: t.crit, primary: true }); }
        act = () => {
            if (live()) { delete armed[key]; return run(); }
            armed[key] = Date.now();
            return null;
        };
    }
    if (!w) w = Math.max(h * 3, cv.textWidth(text, TYPE.body.size, { font: TYPE.body.font }) + 2 * SPACE.m);
    if (o.primary) {
        cv.gradientRect(x, y, w, h, [[0, t.focusTop], [1, t.focusBottom]]);
        cv.fillRect(x, y + h - 3, w, 3, o.color || t.sel);
    } else {
        cv.gradientRect(x, y, w, h, [[0, t.raised], [1, t.raisedBottom]]);
        cv.fillRect(x, y + h - 2, w, 2, o.color ? withAlpha(o.color, 0.85) : t.panelEdge);
    }
    const color = o.busy ? t.dim : o.color && !o.primary ? o.color : t.text;
    cv.text(text, x + w / 2, y + h / 2 + TYPE.body.size * 0.36, TYPE.body.size, color, { font: TYPE.body.font, align: 'center' });
    if (!o.busy && act) cv.target(x, y, w, h, act, key, RADIUS.control);
    return w;
}

/** The width a chip with this text takes. */
function chipWidth(cv, text) {
    return Math.max(96, cv.textWidth(String(text).toUpperCase(), TYPE.tag.size, { font: TYPE.tag.font, spacing: 2 }) + 32);
}

/**
 * A status chip at x, y (36 high). kind 'on': the state holds - iDrive 7's selection (the warm gradient over
 * the accent line, white text); 'off': it does not (flat, grey line, dim text); any other kind (default
 * 'accent'): a tinted tag over a line in that colour. opts: { run, key } makes an on / off chip a switch the
 * touch screen and the controller press (cv.target). Returns its width.
 */
function chip(cv, t, x, y, text, kind, opts) {
    const w = chipWidth(cv, text), label = String(text).toUpperCase(), o = opts || {};
    const opt = { font: TYPE.tag.font, align: 'center', spacing: 2 };
    if (kind === 'on' || kind === 'off') {
        const on = kind === 'on';
        cv.gradientRect(x, y, w, 36, on ? [[0, t.focusTop], [1, t.focusBottom]] : [[0, t.raised], [1, t.raisedBottom]]);
        cv.fillRect(x, y + 34, w, 2, on ? t.accent : t.panelEdge);
        cv.text(label, x + w / 2, y + 25, TYPE.tag.size, on ? t.text : t.dim, opt);
        if (o.run && cv.own && cv.target) cv.target(x, y, w, 36, o.run, o.key || label, RADIUS.control);
        return w;
    }
    const c = stateColor(t, kind || 'accent');
    cv.fillRect(x, y, w, 36, withAlpha(c, 0.16));
    cv.fillRect(x, y + 34, w, 2, c);
    cv.text(label, x + w / 2, y + 25, TYPE.tag.size, c, opt);
    return w;
}

/** A line icon in a size x size box at x, y: 'seat' | 'exhaust' | 'paint' | 'gear' | 'back' | 'next' | 'check'. */
function icon(cv, t, name, x, y, size, color) {
    const c = color || t.text, u = size / 24, w = Math.max(2, 2 * u);
    const L = (pts) => cv.polyline(pts.map((p) => [x + p[0] * u, y + p[1] * u]), w, c);
    if (name === 'seat') {
        L([[9, 3], [11, 15], [20, 15]]);
        L([[14, 15], [14, 21]]);
        L([[9, 21], [20, 21]]);
        cv.circle(x + 8 * u, y + 2.5 * u, 2 * u, c);
    } else if (name === 'exhaust') {
        cv.strokeRoundRect(x + 2 * u, y + 8 * u, 12 * u, 8 * u, 3 * u, w, c);
        L([[14, 12], [19, 12]]);
        cv.strokeRoundRect(x + 19 * u, y + 9.5 * u, 4 * u, 5 * u, 1.5 * u, w, c);
    } else if (name === 'paint') {
        // a drop
        L([[12, 3], [6.5, 12], [6, 15.5], [8, 19], [12, 20.5], [16, 19], [18, 15.5], [17.5, 12], [12, 3]]);
    } else if (name === 'gear') {
        cv.arc(x + 12 * u, y + 12 * u, 5 * u, 5 * u + w, 0, 360, c);
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            cv.line(x + (12 + Math.cos(a) * 7.5) * u, y + (12 + Math.sin(a) * 7.5) * u,
                x + (12 + Math.cos(a) * 10.5) * u, y + (12 + Math.sin(a) * 10.5) * u, w * 1.4, c);
        }
    } else if (name === 'back') L([[15, 4], [7, 12], [15, 20]]);
    else if (name === 'next') L([[9, 4], [17, 12], [9, 20]]);
    else if (name === 'check') L([[4, 12], [10, 18], [20, 6]]);
}

/**
 * One row of an iDrive 7 list in rect r: an icon, the label, on the right a value, a check box (check: true /
 * false) or a tick (tick: true, the chosen one of several), a chevron for a row that opens another list.
 * o: { icon, swatch (a colour shown as a square before the label), label, value, check, tick, next, focus (the
 * controller is on it: the selection), color (the label's), dim (nothing to press), run, key }. The kit draws the controller's ring round its target.
 */
function listRow(cv, t, r, opts) {
    const o = opts || {};
    if (o.focus) {
        cv.gradientRect(r.x, r.y, r.w, r.h, [[0, t.focusTop], [1, t.focusBottom]]);
        cv.fillRect(r.x, r.y + r.h - 3, r.w, 3, t.accent);
    } else cv.fillRect(r.x + SPACE.xs, r.y + r.h - 1, r.w - 2 * SPACE.xs, 1, t.panelEdge);
    const c = o.dim ? t.dim : o.color || t.text, base = r.y + r.h / 2 + TYPE.heading.size * 0.34;
    let x = r.x + SPACE.m;
    if (o.icon) { icon(cv, t, o.icon, x, r.y + (r.h - 32) / 2, 32, c); x += 32 + SPACE.s; }
    if (o.swatch) {
        cv.fillRect(x, r.y + (r.h - 28) / 2, 28, 28, o.swatch);
        cv.strokeRoundRect(x, r.y + (r.h - 28) / 2, 28, 28, 0, 1.5, t.panelEdge);
        x += 28 + SPACE.s;
    }
    cv.text(String(o.label), x, base, TYPE.heading.size, c, { font: TYPE.heading.font });
    let right = r.x + r.w - SPACE.m;
    if (o.next) { icon(cv, t, 'next', right - 22, r.y + (r.h - 22) / 2, 22, t.dim); right -= 22 + SPACE.xs; }
    if (o.check === true || o.check === false) {
        const b = 28, bx = right - b, by = r.y + (r.h - b) / 2;
        cv.strokeRoundRect(bx, by, b, b, 0, 2, o.check ? t.text : t.dim);
        if (o.check) icon(cv, t, 'check', bx + 3, by + 3, b - 6, t.accent);
        right = bx - SPACE.s;
    }
    if (o.tick) { icon(cv, t, 'check', right - 28, r.y + (r.h - 28) / 2, 28, t.accent); right -= 28 + SPACE.s; }
    if (o.value !== undefined && o.value !== null && o.value !== '') {
        cv.text(String(o.value), right, r.y + r.h / 2 + TYPE.body.size * 0.34, TYPE.body.size, t.dim, { font: TYPE.body.font, align: 'right' });
    }
    if (o.run && !o.dim && cv.own && cv.target) cv.target(r.x, r.y, r.w, r.h, o.run, o.key || o.label, 0);
}

/**
 * A hot spot on a picture at cx, cy: a ring with a dot; on: filled with the accent (its list is open or the
 * controller is on it). o: { on, run, key }.
 */
function hotspot(cv, t, cx, cy, opts) {
    const o = opts || {}, r = 17;
    cv.circle(cx, cy, r + 5, withAlpha('#000000', 0.55));
    if (o.on) cv.circle(cx, cy, r, t.accent);
    cv.arc(cx, cy, r - 2.5, r, 0, 360, o.on ? t.text : withAlpha(t.text, 0.9));
    cv.circle(cx, cy, 5, t.text);
    if (o.run && cv.own && cv.target) cv.target(cx - r - 6, cy - r - 6, 2 * r + 12, 2 * r + 12, o.run, o.key || 'hotspot', r + 6);
}

/** The grip on a list's edge that folds it away and brings it back (iDrive 7's white handle): 22 wide at x, mid-height of y..y+h. */
function grip(cv, t, x, y, h, run, key) {
    const gh = Math.min(150, h * 0.34), gy = y + (h - gh) / 2;
    cv.quad([[x, gy], [x + 10, gy + 10], [x + 10, gy + gh - 10], [x, gy + gh]], t.text);
    cv.fillRect(x + 4, gy + gh / 2 - 9, 2, 18, t.bg);
    if (run && cv.own && cv.target) cv.target(x, gy - 6, 22, gh + 12, run, key || 'grip', 4);
}

/**
 * A seat seen from the side, facing left: pos = { fore, height, back } each 0..1
 * (fore 0 = fully forward, back 0 = upright). s = scale (1 = about 260 x 240). color: default the figure grey.
 */
function seat(cv, t, x, y, s, pos, color) {
    const p = pos || {}, c = color || t.figure;
    const fore = G.clamp(p.fore || 0, 0, 1), up = G.clamp(p.height || 0, 0, 1), back = G.clamp(p.back || 0, 0, 1);
    // rail
    cv.fillRect(x, y + 230 * s, 260 * s, 4 * s, t.track);
    const bx = x + (20 + fore * 90) * s, by = y + (150 - up * 30) * s;
    // cushion
    cv.roundRect(bx, by, 130 * s, 34 * s, 14 * s, c);
    cv.fillRect(bx + 50 * s, by + 34 * s, 10 * s, (230 * s) - (by + 34 * s - y), withAlpha(c, 0.5));
    // backrest: a quad leaning back by 0..28 degrees from upright, pivoting at the cushion's rear
    const a = (6 + back * 28) * Math.PI / 180, len = 150 * s, wid = 30 * s;
    const px = bx + 118 * s, py = by + 10 * s;
    const dx = Math.sin(a), dy = -Math.cos(a), nx = Math.cos(a), ny = Math.sin(a);
    cv.quad([[px, py], [px + nx * wid, py + ny * wid], [px + nx * wid + dx * len, py + ny * wid + dy * len], [px + dx * len, py + dy * len]], c);
    // headrest
    const hx = px + dx * (len + 16 * s), hy = py + dy * (len + 16 * s);
    cv.circle(hx + nx * wid * 0.5, hy + ny * wid * 0.5, 17 * s, withAlpha(c, 0.85));
}

/** A thin labelled bar for one seat axis (0..1), the accent over a dark track, like iDrive 7's progress bars. */
function axisBar(cv, t, x, y, w, label, value) {
    cv.text(label, x, y, TYPE.caption.size, t.dim, { font: TYPE.caption.font });
    cv.fillRect(x, y + 14, w, 4, t.track);
    if (G.isNum(value)) cv.fillRect(x, y + 14, Math.max(4, w * G.clamp(value, 0, 1)), 4, t.accent);
}

module.exports = {
    W, H, MARGIN, GUTTER, COL_W, SPACE, RADIUS, LINE, TYPE, PALETTES,
    theme, col, stateColor, tileLine, card, metric, title, button, chip, chipWidth, seat, axisBar,
    icon, listRow, hotspot, grip,
};
