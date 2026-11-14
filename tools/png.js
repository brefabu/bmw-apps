'use strict';
/**
 * png.js - read and write PNG files with Node alone (zlib), for the tools that prepare pictures.
 *
 *   const { read, write } = require('./png');
 *   const im = read(file);            // { w, h, data: Buffer of straight RGBA, 4 bytes a pixel }
 *   write(file, w, h, rgba);
 * read() takes 8-bit greyscale, RGB, palette, grey + alpha and RGBA files, not interlaced.
 */
const fs = require('fs');
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function read(file) {
    const b = fs.readFileSync(file);
    if (b.slice(0, 8).compare(SIG) !== 0) throw new Error(file + ': not a PNG file');
    let o = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, pal = null, trns = null;
    const idat = [];
    while (o < b.length) {
        const len = b.readUInt32BE(o), name = b.toString('latin1', o + 4, o + 8), body = b.slice(o + 8, o + 8 + len);
        if (name === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
        else if (name === 'PLTE') pal = body;
        else if (name === 'tRNS') trns = body;
        else if (name === 'IDAT') idat.push(body);
        else if (name === 'IEND') break;
        o += 12 + len;
    }
    if (depth !== 8 || interlace) throw new Error(file + ': only 8-bit, non-interlaced PNG files');
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!ch) throw new Error(file + ': PNG colour type ' + type);
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], r = y * (stride + 1) + 1, d = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? px[d + x - ch] : 0, up = y ? px[d + x - stride] : 0, c = x >= ch && y ? px[d + x - stride - ch] : 0;
            let v = raw[r + x];
            if (f === 1) v += a;
            else if (f === 2) v += up;
            else if (f === 3) v += (a + up) >> 1;
            else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
            px[d + x] = v & 255;
        }
    }
    const data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        let r, g, bl, a = 255;
        if (type === 6) { r = px[i * 4]; g = px[i * 4 + 1]; bl = px[i * 4 + 2]; a = px[i * 4 + 3]; }
        else if (type === 2) { r = px[i * 3]; g = px[i * 3 + 1]; bl = px[i * 3 + 2]; }
        else if (type === 0) { r = g = bl = px[i]; }
        else if (type === 4) { r = g = bl = px[i * 2]; a = px[i * 2 + 1]; }
        else { const k = px[i]; r = pal[k * 3]; g = pal[k * 3 + 1]; bl = pal[k * 3 + 2]; a = trns && k < trns.length ? trns[k] : 255; }
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = bl; data[i * 4 + 3] = a;
    }
    return { w, h, data };
}

let table = null;
function crc(buf) {
    if (!table) {
        table = new Int32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function write(file, w, h, rgba) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
    const chunk = (name, body) => {
        const out = Buffer.alloc(12 + body.length);
        out.writeUInt32BE(body.length, 0); out.write(name, 4, 'latin1'); body.copy(out, 8);
        out.writeUInt32BE(crc(out.slice(4, 8 + body.length)), 8 + body.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    fs.writeFileSync(file, Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}

module.exports = { read, write };
