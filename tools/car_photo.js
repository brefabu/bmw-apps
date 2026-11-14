'use strict';
/**
 * car_photo.js - turn side photographs of the car, one per paint, into the pictures BRE Hub shows on its first
 * page (apps/bre_hub/car_picture.js draws them).
 *
 *   node tools/car_photo.js [reference/colours.json] [--width 860] [--tol 5]
 *
 * The list (JSON): [{ "id": "mineral", "name": "Mineral Grey", "file": "colours/....png" }, ...], files relative to
 * the list. An entry may add "ground" (the tyres' contact line, image px, when the image has a floor drawn under
 * it) and "floor" (from this row down, what is lighter than the tyres is that floor: it becomes the shadow's black). Each image: a PNG with a transparent background, the car seen from the side, facing left, filling the
 * width. Every paint is its own photograph, used as rendered: nothing is recoloured or cut out (the windows too:
 * darkening them took the window frame's seal with it, and the renders look better as they are).
 *
 * It writes apps/bre_hub/car_photo_<id>.js for each, apps/bre_hub/car_photos.js (the list: ids, names) and, beside
 * the list, preview-<id>.png and preview-all.png. The images belong to whoever made them: note where they come from
 * in THIRD_PARTY.md.
 *
 * For each image:
 *   1. the car's outline: the opaque pixels (the shadow under it is half transparent), its length and ground line;
 *   2. scaled to the screen's pixels (the car --width logical px long, x 1.164 on the 1920 px screen), the floor's
 *      reflection added under the ground line;
 *   3. cells: flat ones and shaded ones (a colour at each corner), fitted within a tolerance (--tol).
 * The seat and the tailpipe hot spots are placed at fixed shares of the car's length and height.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Module = require('module');
const png = require('./png');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'bre_hub');
// the app's modules ask for ./kit/<name>: in the repository that is kit/runtime/<name>.js
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request) {
    const m = /^\.\/kit\/(\w+)$/.exec(request);
    if (m) return path.join(ROOT, 'kit', 'runtime', m[1] + '.js');
    return resolve.apply(this, arguments);
};

const K = 1.164;                              // device px a logical px on the 1920 px screen
const SEAT = [0.457, 0.535];                  // the driver's seat: share of the car's length, of its height
const EXHAUST = [1.012, 0.748];               // the tailpipe hot spot: just behind the rear bumper
const REFLECTION = 0.34;                      // the floor's reflection: share of the car's height

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const LWant = Number(opt('--width', 860)), TOL = Number(opt('--tol', 5));
const listFile = path.resolve(args[0] || path.join(ROOT, 'reference', 'colours.json'));
const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const where = path.dirname(listFile);

/** The image and its car's outline. */
function analyse(src, entry) {
    /* ---------------------------------------------------------------- 1. outline */
    const im = png.read(src), SW = im.w, SH = im.h, sd = im.data;
    let minx = SW, maxx = 0, top = SH, ground = 0;
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        if (sd[(y * SW + x) * 4 + 3] < 250) continue;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < top) top = y;
        if (y > ground) ground = y;
    }
    if (entry.ground) ground = entry.ground;
    const lumAt = (i) => sd[i * 4] * 0.299 + sd[i * 4 + 1] * 0.587 + sd[i * 4 + 2] * 0.114;
    // a floor drawn under the car: what is lighter than the tyres becomes the shadow's black
    if (entry.floor) for (let y = entry.floor; y < SH; y++) for (let x = 0; x < SW; x++) {
        const i = y * SW + x;
        if (lumAt(i) >= 60) { sd[i * 4] = sd[i * 4 + 1] = sd[i * 4 + 2] = 0; }
    }

    return { SW, SH, sd, minx, maxx, top, ground };
}

/** One image as a picture. */
function convert(a) {
    const SW = a.SW, SH = a.SH, sd = a.sd, minx = a.minx, maxx = a.maxx, ground = a.ground;
    let top = a.top;

    /* ---------------------------------------------------------------- 2. to the screen's pixels */
    top = Math.max(0, top - 2);
    const f = LWant * K / (maxx - minx + 1);
    const DW = Math.round((maxx - minx + 1) * f) + 2, groundD = Math.round((ground + 1 - top) * f);
    const reflD = Math.round((ground - top) * f * REFLECTION), DH = groundD + reflD;
    const P = new Float32Array(DW * DH * 4);                      // premultiplied RGB, A (0..255), area-averaged
    for (let y = 0; y < Math.min(DH, groundD + 8); y++) {
        const sy0 = top + y / f, sy1 = top + (y + 1) / f;
        for (let x = 0; x < DW; x++) {
            const sx0 = minx - 1 + x / f, sx1 = minx - 1 + (x + 1) / f;
            let r = 0, g = 0, b = 0, a = 0, wsum = 0;
            for (let yy = Math.floor(sy0); yy < Math.ceil(sy1) && yy < SH; yy++) {
                const wy = Math.min(sy1, yy + 1) - Math.max(sy0, yy);
                for (let xx = Math.max(0, Math.floor(sx0)); xx < Math.ceil(sx1) && xx < SW; xx++) {
                    const w = wy * (Math.min(sx1, xx + 1) - Math.max(sx0, xx)), i = yy * SW + xx, al = sd[i * 4 + 3] / 255;
                    r += sd[i * 4] * al * w; g += sd[i * 4 + 1] * al * w; b += sd[i * 4 + 2] * al * w; a += al * w; wsum += w;
                }
            }
            if (!wsum) continue;
            const o = (y * DW + x) * 4;
            P[o] = r / wsum; P[o + 1] = g / wsum; P[o + 2] = b / wsum; P[o + 3] = 255 * a / wsum;
        }
    }
    // the floor's reflection: the car mirrored at the ground line, fading out, under what is there (the shadow)
    for (let d = 1; d <= reflD; d++) {
        const y = groundD + d - 1, ys = groundD - d;
        if (ys < 0 || y >= DH) break;
        const fade = 0.3 * Math.pow(1 - d / reflD, 1.7);
        for (let x = 0; x < DW; x++) {
            const o = (y * DW + x) * 4, s = (ys * DW + x) * 4, keep = 1 - P[o + 3] / 255;
            P[o] += P[s] * fade * keep; P[o + 1] += P[s + 1] * fade * keep; P[o + 2] += P[s + 2] * fade * keep;
            P[o + 3] = 255 * (P[o + 3] / 255 + P[s + 3] / 255 * fade * keep);
        }
    }

    /* ---------------------------------------------------------------- 3. cells */
    const flat = [], shaded = [], S = new Float32Array(DW * DH * 3);
    for (let i = 0; i < DW * DH; i++) { const a = P[i * 4 + 3]; if (a > 0) for (let c = 0; c < 3; c++) S[i * 3 + c] = Math.min(255, P[i * 4 + c] * 255 / a); }
    const wv = new Float32Array(4);
    function weights(d, U, V) {
        wv[0] = wv[1] = wv[2] = wv[3] = 0;
        if (d === 0) { if (U >= V) { wv[0] = 1 - U; wv[1] = U - V; wv[3] = V; } else { wv[0] = 1 - V; wv[2] = V - U; wv[3] = U; } }
        else if (U + V <= 1) { wv[0] = 1 - U - V; wv[1] = U; wv[2] = V; }
        else { wv[3] = U + V - 1; wv[1] = 1 - V; wv[2] = 1 - U; }
    }
    function solve4(N, rhs) {
        const A = [0, 1, 2, 3].map((i) => N[i].slice().concat(rhs[i]));
        for (let c = 0; c < 4; c++) {
            let p = c;
            for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
            const t = A[c]; A[c] = A[p]; A[p] = t;
            if (Math.abs(A[c][c]) < 1e-12) return null;
            for (let r = 0; r < 4; r++) {
                if (r === c) continue;
                const k = A[r][c] / A[c][c];
                for (let j = c; j < 5; j++) A[r][j] -= k * A[c][j];
            }
        }
        return [0, 1, 2, 3].map((i) => A[i][4] / A[i][i]);
    }
    function fitShaded(x, y, w, h, d) {
        const zero = () => [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        const Nc = zero(), Na = zero(), rc = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], ra = [0, 0, 0, 0];
        for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
            weights(d, (px + 0.5) / w, (py + 0.5) / h);
            const i = (y + py) * DW + x + px, a = P[i * 4 + 3], wt = a / 255 + 1e-3;
            for (let j = 0; j < 4; j++) {
                if (!wv[j]) continue;
                for (let k = 0; k < 4; k++) { Nc[j][k] += wt * wv[j] * wv[k]; Na[j][k] += wv[j] * wv[k]; }
                for (let c = 0; c < 3; c++) rc[c][j] += wt * wv[j] * S[i * 3 + c];
                ra[j] += wv[j] * a;
            }
        }
        for (let j = 0; j < 4; j++) { Nc[j][j] += 1e-6; Na[j][j] += 1e-6; }
        const sa = solve4(Na, ra), sc = rc.map((r) => solve4(Nc, r));
        if (!sa || sc.some((s) => !s)) return null;
        const q = [0, 1, 2, 3].map((j) => [0, 1, 2].map((c) => Math.max(0, Math.min(255, Math.round(sc[c][j])))).concat(Math.max(0, Math.min(255, Math.round(sa[j])))));
        for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
            weights(d, (px + 0.5) / w, (py + 0.5) / h);
            const i = ((y + py) * DW + x + px) * 4;
            const a = wv[0] * q[0][3] + wv[1] * q[1][3] + wv[2] * q[2][3] + wv[3] * q[3][3];
            if (Math.abs(a - P[i + 3]) > TOL) return null;
            for (let c = 0; c < 3; c++) if (Math.abs((wv[0] * q[0][c] + wv[1] * q[1][c] + wv[2] * q[2][c] + wv[3] * q[3][c]) * a / 255 - P[i + c]) > TOL) return null;
        }
        return q;
    }
    function fit(x, y, w, h) {
        let amax = 0, asum = 0;
        const cs = [0, 0, 0];
        for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
            const i = (py * DW + px) * 4;
            if (P[i + 3] > amax) amax = P[i + 3];
            asum += P[i + 3]; cs[0] += P[i]; cs[1] += P[i + 1]; cs[2] += P[i + 2];
        }
        if (amax < 0.5) return;
        const A = Math.round(asum / (w * h)), col = cs.map((v) => Math.max(0, Math.min(255, Math.round(asum > 0 ? v * 255 / asum : 0))));
        let ok = true;
        for (let py = y; ok && py < y + h; py++) for (let px = x; px < x + w; px++) {
            const i = (py * DW + px) * 4;
            if (Math.abs(A - P[i + 3]) > TOL || [0, 1, 2].some((c) => Math.abs(col[c] * A / 255 - P[i + c]) > TOL)) { ok = false; break; }
        }
        if (ok || (w === 1 && h === 1)) { if (A > 0) flat.push({ x, y, w, h, c: col.concat(A) }); return; }
        if (w >= 2 && h >= 2) for (let d = 0; d < 2; d++) { const q = fitShaded(x, y, w, h, d); if (q) { shaded.push({ x, y, w, h, d, q }); return; } }
        const hw = w >> 1, hh = h >> 1;
        if (w >= 2 && h >= 2) { fit(x, y, hw, hh); fit(x + hw, y, w - hw, hh); fit(x, y + hh, hw, h - hh); fit(x + hw, y + hh, w - hw, h - hh); }
        else if (w >= 2) { fit(x, y, hw, h); fit(x + hw, y, w - hw, h); }
        else { fit(x, y, w, hh); fit(x, y + hh, w, h - hh); }
    }
    for (let y = 0; y < DH; y += 32) for (let x = 0; x < DW; x += 32) fit(x, y, Math.min(32, DW - x), Math.min(32, DH - y));

    const NF = flat.length, NT = shaded.length, buf = Buffer.alloc(NF * 12 + NT * 25);
    let o = 0;
    const packed = (c) => ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
    flat.forEach((c) => { [c.x, c.y, c.w, c.h].forEach((v) => { buf.writeUInt16LE(v, o); o += 2; }); });
    flat.forEach((c) => { buf.writeUInt32BE(packed(c.c), o); o += 4; });
    shaded.forEach((c) => { [c.x, c.y, c.w, c.h].forEach((v) => { buf.writeUInt16LE(v, o); o += 2; }); });
    shaded.forEach((c) => { buf[o++] = c.d; });
    shaded.forEach((c) => { c.q.forEach((q) => { buf.writeUInt32BE(packed(q), o); o += 4; }); });
    const len = (maxx - minx + 1) * f / K, high = (ground + 1 - top) * f / K, r1 = (v) => Math.round(v * 10) / 10;
    return {
        photo: {
            LW: Math.ceil(DW / K), LH: Math.ceil(DH / K), DW, DH, K, NF, NT, ground: r1(groundD / K),
            seat: [r1(len * SEAT[0]), r1(high * SEAT[1])], exhaust: [r1(len * EXHAUST[0]), r1(high * EXHAUST[1])],
            data: zlib.deflateSync(buf, { level: 9 }).toString('base64'),
        },
        stats: SW + 'x' + SH + ', car ' + (maxx - minx + 1) + ' px long, ' + NF + ' flat + ' + NT + ' shaded cells',
    };
}

function writeModule(file, head, value) {
    const data = value.data, lines = [];
    for (let i = 0; i < data.length; i += 160) lines.push("    '" + data.slice(i, i + 160) + "'");
    fs.writeFileSync(file, ["'use strict';", '/**'].concat(head.map((l) => ' * ' + l), [' */',
        'module.exports = ' + JSON.stringify(Object.assign({}, value, { data: '@' })).replace('"@"', '[\n' + lines.join(',\n') + ",\n].join('')") + ';', '']).join('\n'));
}

const Picture = require(path.join(APP, 'car_picture.js'));
const made = {}, index = [];
list.forEach((e) => { if (!/^[a-z][a-z0-9]*$/.test(e.id)) throw new Error('paint id ' + e.id + ': lower-case letters and digits'); });
const analysed = list.map((e) => analyse(path.resolve(where, e.file), e));
list.forEach((e, k) => {
    const src = path.resolve(where, e.file), r = convert(analysed[k]);
    const file = path.join(APP, 'car_photo_' + e.id + '.js');
    writeModule(file, ['car_photo_' + e.id + '.js - ' + e.name + ': the car\'s picture as cells (car_picture.js draws it).',
        'MADE BY tools/car_photo.js from ' + path.basename(src) + ': do not edit. The image belongs to whoever made it:',
        'publish this file only if you may publish the image.'], r.photo);
    made[e.id] = r.photo;
    index.push({ id: e.id, name: e.name });
    console.log(e.id.padEnd(9) + r.stats + ', ' + Math.round(fs.statSync(file).size / 1024) + ' kB');
});
fs.writeFileSync(path.join(APP, 'car_photos.js'), ["'use strict';", '/** car_photos.js - the paints there is a photograph of (car_photo_<id>.js). MADE BY tools/car_photo.js: do not edit. */',
    'module.exports = ' + JSON.stringify(index, null, 1) + ';', ''].join('\n'));

// previews: each picture as the app shades it, over the page's black, and all of them on one sheet
Picture.use(index, made);
const shots = index.map((e) => {
    const px = Picture.pixels(e.id), out = Buffer.alloc(px.w * px.h * 4);
    for (let i = 0; i < px.w * px.h; i++) {
        const a = px.d[i * 4 + 3] / 255;
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(px.d[i * 4 + c] * a);
        out[i * 4 + 3] = 255;
    }
    png.write(path.join(where, 'preview-' + e.id + '.png'), px.w, px.h, out);
    return { w: px.w, h: px.h, d: out };
});
const cols = 2, tw = Math.max.apply(null, shots.map((s) => s.w)), th = Math.max.apply(null, shots.map((s) => s.h)), rows = Math.ceil(shots.length / cols);
const sheet = Buffer.alloc(tw * cols * th * rows * 4);
shots.forEach((s, k) => {
    const ox = (k % cols) * tw, oy = Math.floor(k / cols) * th;
    for (let y = 0; y < s.h; y++) s.d.copy(sheet, ((oy + y) * tw * cols + ox) * 4, y * s.w * 4, (y + 1) * s.w * 4);
});
for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;
png.write(path.join(where, 'preview-all.png'), tw * cols, th * rows, sheet);
console.log('previews in ' + path.relative(ROOT, where) + ' (preview-<id>.png, preview-all.png)');
