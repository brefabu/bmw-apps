'use strict';
/**
 * car_picture.js - the car's photograph on the first page, one photograph per paint.
 *
 * The app's renderer (mgu-render/1) takes no pixel pictures from the kit, so a picture is kept as cells on the
 * device pixel grid: flat cells (one colour) and shaded cells (two triangles with a colour at each corner, which
 * the GPU blends across the cell). They are drawn ONCE into a cached layer (a texture in the renderer, one blit a
 * frame). The technique, draw() and the pixel sampling in soft() are adapted from idrive7-apps
 * apps/live_adjustments/muffler_img.js (https://github.com/cauliflowermossgrape/idrive7-apps, commit
 * 8d860de5818a2da11d3a3750aab36866cecf6bde, MIT, Copyright (c) 2026 cauliflowermossgrape). See NOTICE.
 *
 * The pictures are made by tools/car_photo.js: car_photos.js lists the paints there is one of, car_photo_<id>.js
 * holds each (stock renders, not ours: THIRD_PARTY.md). They are optional: without them list() is empty and
 * the page draws the car itself (car_art.js). Only the picture of the paint shown is loaded.
 *
 *   list()                          [{ id, name }]: the paints there is a photograph of
 *   available(id)                   that paint's photograph is packed
 *   info(id)                        { LW, LH, ground, seat: [x, y], exhaust: [x, y] } in logical px of the picture
 *   blit(cv, G, x, y, id)           draw it at x, y; false when it is not there
 *   pixels(id)                      { w, h, d }: the picture as straight RGBA at device px (the tool's previews)
 *   use(list, photos)               pictures made elsewhere ({ id: car_photo object }): the tool, the tests
 */
const zlib = require('zlib');

let index;                                // undefined: not looked yet
let given = null;                         // use(): { id: photo }
const photos = {};                        // id -> photo object, or null when it is not packed
const cells = {};                         // id -> decoded cells

function optional(name) {
    try { return require(name); } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).indexOf(name.slice(2)) >= 0) return null;
        throw e;
    }
}

function list() {
    if (index === undefined) index = optional('./car_photos') || [];
    return index;
}
function asset(id) {
    if (!/^[a-z][a-z0-9]*$/.test(String(id)) || !list().some((e) => e.id === id)) return null;
    if (photos[id] === undefined) photos[id] = given ? given[id] || null : optional('./car_photo_' + id);
    return photos[id];
}
function use(l, p) {
    index = l || []; given = p || {};
    Object.keys(photos).forEach((k) => { delete photos[k]; });
    Object.keys(cells).forEach((k) => { delete cells[k]; });
}

/** deflated: flat cells (x, y, w, h u16) x NF, their RGBA x NF; shaded cells (x, y, w, h u16) x NT, diagonal u8
 * x NT (0: corners 00-11, 1: corners 10-01), corner RGBA (00, 10, 01, 11) x NT */
function load(id) {
    if (cells[id]) return cells[id];
    const p = asset(id);
    if (!p) return null;
    const b = zlib.inflateSync(Buffer.from(p.data, 'base64')), NF = p.NF, NT = p.NT;
    let o = 0;
    const u16 = (n) => { const a = new Uint16Array(n); for (let i = 0; i < n; i++) a[i] = b.readUInt16LE(o + i * 2); o += n * 2; return a; };
    const u32 = (n) => { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = b.readUInt32BE(o + i * 4); o += n * 4; return a; };
    const u8 = (n) => { const a = new Uint8Array(b.buffer, b.byteOffset + o, n); o += n; return a; };
    const fg = u16(NF * 4), fc = u32(NF), tg = u16(NT * 4), td = u8(NT), tc = u32(NT * 4);
    // one picture kept decoded: the paint changes rarely
    Object.keys(cells).forEach((k) => { delete cells[k]; });
    return (cells[id] = { fg, fc, tg, td, tc, NF, NT, K: p.K, DW: p.DW, DH: p.DH });
}

function available(id) { return !!asset(id); }
function info(id) {
    const p = asset(id);
    return p ? { LW: p.LW, LH: p.LH, ground: p.ground, seat: p.seat, exhaust: p.exhaust } : null;
}

/** The picture into cv (a layer's recorder, logical px). OP: kit/record's op codes. */
function draw(cv, OP, id) {
    const c = load(id), s = 1 / c.K, NF = c.NF, NT = c.NT;
    if (!(cv._grow && cv.u && cv.f)) {        // not a recorder: flat colours only
        for (let i = 0; i < NF; i++) cv.fillRect(c.fg[i * 4] * s, c.fg[i * 4 + 1] * s, c.fg[i * 4 + 2] * s, c.fg[i * 4 + 3] * s, c.fc[i]);
        for (let i = 0; i < NT; i++) cv.fillRect(c.tg[i * 4] * s, c.tg[i * 4 + 1] * s, c.tg[i * 4 + 2] * s, c.tg[i * 4 + 3] * s, c.tc[i * 4]);
        return cv;
    }
    // one TRIS op: 2 triangles a shaded cell, (x y colour) x 3 each
    cv._grow(2 + NT * 18);
    let u = cv.u, f = cv.f, n = cv.n;
    u[n++] = OP.TRIS; u[n++] = NT * 2;
    for (let i = 0; i < NT; i++) {
        const x0 = c.tg[i * 4] * s, y0 = c.tg[i * 4 + 1] * s, x1 = x0 + c.tg[i * 4 + 2] * s, y1 = y0 + c.tg[i * 4 + 3] * s;
        const c00 = c.tc[i * 4], c10 = c.tc[i * 4 + 1], c01 = c.tc[i * 4 + 2], c11 = c.tc[i * 4 + 3];
        if (c.td[i] === 0) {
            f[n] = x0; f[n + 1] = y0; u[n + 2] = c00; f[n + 3] = x1; f[n + 4] = y0; u[n + 5] = c10; f[n + 6] = x1; f[n + 7] = y1; u[n + 8] = c11;
            f[n + 9] = x0; f[n + 10] = y0; u[n + 11] = c00; f[n + 12] = x1; f[n + 13] = y1; u[n + 14] = c11; f[n + 15] = x0; f[n + 16] = y1; u[n + 17] = c01;
        } else {
            f[n] = x0; f[n + 1] = y0; u[n + 2] = c00; f[n + 3] = x1; f[n + 4] = y0; u[n + 5] = c10; f[n + 6] = x0; f[n + 7] = y1; u[n + 8] = c01;
            f[n + 9] = x1; f[n + 10] = y0; u[n + 11] = c10; f[n + 12] = x1; f[n + 13] = y1; u[n + 14] = c11; f[n + 15] = x0; f[n + 16] = y1; u[n + 17] = c01;
        }
        n += 18;
    }
    cv.n = n;
    // the flat cells: a RECT each
    cv._grow(NF * 6);
    u = cv.u; f = cv.f; n = cv.n;
    for (let i = 0; i < NF; i++) {
        u[n] = OP.RECT; f[n + 1] = c.fg[i * 4] * s; f[n + 2] = c.fg[i * 4 + 1] * s; f[n + 3] = c.fg[i * 4 + 2] * s; f[n + 4] = c.fg[i * 4 + 3] * s; u[n + 5] = c.fc[i];
        n += 6;
    }
    cv.n = n;
    return cv;
}

/** The cells shaded as the GPU does, at device px: Float32 premultiplied RGB + A (0..255), DW x DH. */
function shade(id) {
    const c = load(id), DW = c.DW, DH = c.DH, P = new Float32Array(DW * DH * 4);
    const put = (i, r, g, b, a) => { const k = a / 255; P[i] = r * k; P[i + 1] = g * k; P[i + 2] = b * k; P[i + 3] = a; };
    for (let i = 0; i < c.NF; i++) {
        const x = c.fg[i * 4], y = c.fg[i * 4 + 1], w = c.fg[i * 4 + 2], h = c.fg[i * 4 + 3], v = c.fc[i];
        const r = v >>> 24, g = (v >>> 16) & 255, b = (v >>> 8) & 255, a = v & 255;
        for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) put((py * DW + px) * 4, r, g, b, a);
    }
    const q = new Float32Array(16);
    for (let i = 0; i < c.NT; i++) {
        const x = c.tg[i * 4], y = c.tg[i * 4 + 1], w = c.tg[i * 4 + 2], h = c.tg[i * 4 + 3], d = c.td[i];
        for (let k = 0; k < 4; k++) { const v = c.tc[i * 4 + k]; q[k * 4] = v >>> 24; q[k * 4 + 1] = (v >>> 16) & 255; q[k * 4 + 2] = (v >>> 8) & 255; q[k * 4 + 3] = v & 255; }
        for (let py = 0; py < h; py++) {
            const V = (py + 0.5) / h;
            for (let px = 0; px < w; px++) {
                const U = (px + 0.5) / w;
                let w0 = 0, w1 = 0, w2 = 0, w3 = 0;          // corners 00, 10, 01, 11 (as the GPU splits the cell)
                if (d === 0) { if (U >= V) { w0 = 1 - U; w1 = U - V; w3 = V; } else { w0 = 1 - V; w2 = V - U; w3 = U; } }
                else if (U + V <= 1) { w0 = 1 - U - V; w1 = U; w2 = V; }
                else { w3 = U + V - 1; w1 = 1 - V; w2 = 1 - U; }
                const ch = (o) => w0 * q[o] + w1 * q[4 + o] + w2 * q[8 + o] + w3 * q[12 + o];
                put(((y + py) * DW + x + px) * 4, ch(0), ch(1), ch(2), ch(3));
            }
        }
    }
    return { P, DW, DH };
}

/** The picture as straight RGBA at device px. */
function pixels(id) {
    const s = shade(id), n = s.DW * s.DH, d = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        const A = s.P[i * 4 + 3];
        if (A < 0.5) continue;
        for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = Math.min(255, Math.round(s.P[i * 4 + ch] * 255 / A));
        d[i * 4 + 3] = Math.min(255, Math.round(A));
    }
    return { w: s.DW, h: s.DH, d };
}

/** The picture as pixels into a software canvas (canvas.js, straight RGBA) of any size: sampled (bilinear) down. */
function soft(cv, id) {
    const s = shade(id), P = s.P, DW = s.DW, DH = s.DH;
    const out = cv.d, W = cv.w, H = cv.h, sx = DW / W, sy = DH / H;
    for (let oy = 0; oy < H; oy++) {
        const fy = Math.min(DH - 1, Math.max(0, (oy + 0.5) * sy - 0.5)), y0 = fy | 0, y1 = Math.min(DH - 1, y0 + 1), ty = fy - y0;
        for (let ox = 0; ox < W; ox++) {
            const fx = Math.min(DW - 1, Math.max(0, (ox + 0.5) * sx - 0.5)), x0 = fx | 0, x1 = Math.min(DW - 1, x0 + 1), tx = fx - x0;
            const a = (y0 * DW + x0) * 4, b = (y0 * DW + x1) * 4, e = (y1 * DW + x0) * 4, f = (y1 * DW + x1) * 4;
            const k00 = (1 - tx) * (1 - ty), k10 = tx * (1 - ty), k01 = (1 - tx) * ty, k11 = tx * ty;
            const A = P[a + 3] * k00 + P[b + 3] * k10 + P[e + 3] * k01 + P[f + 3] * k11;
            const o = (oy * W + ox) * 4;
            if (A < 0.5) { out[o + 3] = 0; continue; }
            for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.min(255, Math.round((P[a + ch] * k00 + P[b + ch] * k10 + P[e + ch] * k01 + P[f + ch] * k11) * 255 / A));
            out[o + 3] = Math.min(255, Math.round(A));
        }
    }
    return cv;
}

/**
 * Draw paint id's picture at x, y (logical px). G: kit/gauges (its layer cache). The software renderer would play
 * the layer's shaded triangles in flat colours: it gets the picture as pixels instead (made the first time it
 * asks; the GPU never reads them).
 */
function blit(cv, G, x, y, id) {
    const p = asset(id);
    if (!p || !cv.blit || !G.layer) return false;
    const { OP } = require('./kit/record');
    const pic = G.layer('bre_car_picture|' + id, p.LW, p.LH, (c) => draw(c, OP, id), cv.textScale);
    if (pic && !pic.carSoft) {
        let px = null;
        Object.defineProperty(pic, 'soft', {
            configurable: true, enumerable: true,
            get() { if (!px) { const { Canvas } = require('./kit/canvas'); px = soft(new Canvas(pic.w, pic.h), id); } return px; },
            set(v) { px = v; },
        });
        pic.carSoft = true;
    }
    cv.blit(pic, Math.round(x), Math.round(y));
    return true;
}

module.exports = { list, available, info, blit, pixels, use, draw, soft };
