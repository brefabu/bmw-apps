'use strict';
/**
 * test_seat_link.js - the seat probe (apps/bre_hub/seat_link.js) without a car: a fake diagnostic transport that
 * records every request. What matters most: only reads (22) leave, only to the driver's seat module (0x6D), only
 * the identifiers in READS; nothing else, ever.
 *
 *   node tests/test_seat_link.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// the app requires its kit as ./kit/<module>: point that at the kit's runtime
const KIT = path.join(__dirname, '..', 'kit', 'runtime');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, isMain, opts) {
    if (req.indexOf('./kit/') === 0) return resolve.call(this, path.join(KIT, req.slice(6)), parent, isMain, opts);
    return resolve.call(this, req, parent, isMain, opts);
};
const L = require('../apps/bre_hub/seat_link');

const quiet = { info() {}, warn() {}, error() {} };
let passed = 0;
function test(name, fn) {
    return Promise.resolve().then(fn).then(() => { passed++; }, (e) => { e.message = name + ': ' + e.message; throw e; });
}

/** A Diag stand-in: answers 22 <DID> from table (did -> bytes | 'nrc' | null), records every request. */
function fakeDiag(table) {
    const d = {
        quiet: false, sent: [],
        async physical(target, sid, data, timeoutMs, accept) {
            d.sent.push({ target: target, sid: sid, data: data.slice(), quietWhileSent: d.quiet });
            const did = (data[0] << 8) | data[1];
            const a = table[did];
            if (a === undefined || a === null) return null;                  // timeout
            const reply = a === 'nrc' ? [0x7F, 0x22, 0x31] : [0x62, data[0], data[1]].concat(a);
            assert.ok(!accept || accept(reply), 'the reply matches its request');
            return reply;
        },
    };
    return d;
}
const linkOf = (diag, available) => ({ diag: diag, available: available !== false });

const be16 = (v) => [v >> 8, v & 0xFF];
const CONFIG = [2, 2, 1, 0].concat(new Array(21).fill(0));                   // fore/aft, height with sensors; backrest motor only
const INIT = [1, 1, 1, 0, 0, 0, 1, 1, 2, 2].concat(new Array(95).fill(0));
const hall = (slv, shv) => be16(slv).concat(be16(shv), be16(0), new Array(16).fill(0));
// D708: per axis 0 off, 1 plus (forward / up), 2 minus (back / down), 3 not fitted
const motor = (slv, shv) => [slv, shv, 0, 3, 3, 3, 3, 3, 0, 0, 0];
const MOTOR_OFF = motor(0, 0);
const OFF = 0, PLUS = 1, MINUS = 2;
const SW_NONE = [0, 0, 0, 0, 2, 2].concat(new Array(13).fill(2));
const SW_SLV_BACK = [0, 1, 0, 0, 2, 2].concat(new Array(13).fill(2));
const SW_SLV_FWD = [1, 0, 0, 0, 2, 2].concat(new Array(13).fill(2));

/**
 * A seat that moves under the probe: each step is one poll, { slv, shv } counters and the motor directions the
 * module reports during it. Returns the probe after the run.
 */
async function drive(probe, table, steps) {
    for (const s of steps) {
        table[0xD702] = hall(s.slv, s.shv);
        table[0xD708] = motor(s.ms || OFF, s.mh || OFF);
        table[0xD712] = s.sw || SW_NONE;
        await probe.tick();
    }
    return probe;
}

Promise.resolve()
.then(() => test('parsers read the FAS_G11 layouts', () => {
    assert.deepStrictEqual(L.parseConfig(CONFIG), { slv: 2, shv: 2, lnv: 1 });
    assert.deepStrictEqual(L.parseHall(hall(30000, 20000)), { slv: 30000, shv: 20000, lnv: null }, 'a counter of 0 is outside 8192..57344');
    assert.deepStrictEqual(L.parseInit(INIT), { initialised: true, normed: { slv: true, shv: true, lnv: null } });
    assert.deepStrictEqual(L.parseMotor([1, 2, 3]), { slv: 'plus', shv: 'minus', lnv: null });
    assert.deepStrictEqual(L.parseSwitches(SW_NONE), { pressed: false, axes: { slv: false, shv: false, lnv: false } });
    assert.deepStrictEqual(L.parseSwitches(SW_SLV_BACK), { pressed: true, axes: { slv: 'minus', shv: false, lnv: false } });
    assert.strictEqual(L.parseSwitches(SW_SLV_FWD).axes.slv, 'plus');
}))
.then(() => test('only reads of the listed identifiers leave, only to 0x6D', async () => {
    const diag = fakeDiag({ 0xD700: CONFIG });
    const seat = new L.SeatLink(linkOf(diag), quiet);
    const r = await seat.read(0xD722);                                        // the Hall counter reset's DID: never
    assert.strictEqual(r.ok, false);
    assert.strictEqual(diag.sent.length, 0, 'an identifier not in READS is not even sent');
    await seat.read(0xD700);
    assert.deepStrictEqual(diag.sent, [{ target: 0x6D, sid: 0x22, data: [0xD7, 0x00], quietWhileSent: true }]);
    assert.strictEqual(diag.quiet, false, 'the transport\'s own logging is put back');
    assert.deepStrictEqual(L.READS.slice().sort(), [0xD700, 0xD702, 0xD704, 0xD708, 0xD712]);
}))
.then(() => test('no link: nothing is sent', async () => {
    const diag = fakeDiag({ 0xD700: CONFIG });
    const probe = new L.SeatProbe(new L.SeatLink(linkOf(diag, false), quiet), quiet, null);
    await probe.tick();
    assert.strictEqual(probe.state, 'nolink');
    assert.strictEqual(diag.sent.length, 0);
}))
.then(() => test('no seat module: says so, and keeps asking only D700', async () => {
    const diag = fakeDiag({});
    const probe = new L.SeatProbe(new L.SeatLink(linkOf(diag), quiet), quiet, null);
    await probe.tick(); await probe.tick();
    assert.strictEqual(probe.state, 'none');
    assert.strictEqual(probe.reason, 'timeout');
    assert.ok(diag.sent.every((s) => s.sid === 0x22 && s.target === 0x6D && s.data[0] === 0xD7 && s.data[1] === 0x00));
}))
.then(() => test('a module that refuses: the refusal is the reason', async () => {
    const probe = new L.SeatProbe(new L.SeatLink(linkOf(fakeDiag({ 0xD700: 'nrc' })), quiet), quiet, null);
    await probe.tick();
    assert.strictEqual(probe.state, 'none');
    assert.strictEqual(probe.reason, 'out of range');
}))
.then(() => test('found: positions, switches and the measured travel, kept in the data folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bre-seat-'));
    const table = { 0xD700: CONFIG, 0xD704: INIT, 0xD702: hall(30000, 20000), 0xD708: MOTOR_OFF, 0xD712: SW_NONE };
    const diag = fakeDiag(table);
    const probe = new L.SeatProbe(new L.SeatLink(linkOf(diag), quiet), quiet, dir);
    await probe.tick();
    assert.strictEqual(probe.state, 'found');
    assert.deepStrictEqual(probe.config, { slv: 2, shv: 2, lnv: 1 });
    assert.strictEqual(probe.init.initialised, true);
    assert.deepStrictEqual(probe.hall, { slv: 30000, shv: 20000, lnv: null });
    assert.strictEqual(probe.switches.pressed, false);
    assert.strictEqual(probe.percent('slv'), null, 'one position is no travel yet');
    // ends seen without the module saying which way the motor ran: no share, no direction guessed
    await drive(probe, table, [{ slv: 20000, shv: 20000 }, { slv: 40000, shv: 20000 }]);
    assert.deepStrictEqual(probe.travel.slv, [20000, 40000]);
    assert.strictEqual(probe.risesToward('slv'), null);
    assert.strictEqual(probe.percent('slv'), null, 'a direction is never assumed');
    // the seat driven back (MINUS) with its own switch: the counter falls as it goes back
    await drive(probe, table, [
        { slv: 39000, shv: 20000, ms: MINUS, sw: SW_SLV_BACK },
        { slv: 37000, shv: 20000, ms: MINUS, sw: SW_SLV_BACK },
        { slv: 35000, shv: 20000, ms: MINUS, sw: SW_SLV_BACK },
    ]);
    assert.strictEqual(probe.switches.pressed, true);
    assert.strictEqual(probe.risesToward('slv'), 'front');
    assert.strictEqual(probe.percent('slv'), 25, '(40000 - 35000) / 20000 back');
    assert.strictEqual(probe.percent('shv'), null, 'height: one position, no travel');
    probe._saveAt = 0; probe._dirty = true; probe._save();
    const again = new L.SeatProbe(new L.SeatLink(linkOf(fakeDiag(table)), quiet), quiet, dir);
    assert.deepStrictEqual(again.travel.slv, [20000, 40000], 'the travel survives a restart');
    assert.strictEqual(again.risesToward('slv'), 'front', 'and so does the direction');
    again.resetTravel();
    assert.deepStrictEqual([again.travel, again.rises], [{}, {}]);
    // everything that left: reads to 0x6D of the listed identifiers, nothing else
    assert.ok(diag.sent.length > 0);
    diag.sent.forEach((s) => {
        assert.strictEqual(s.target, 0x6D);
        assert.strictEqual(s.sid, 0x22);
        assert.ok(L.READS.indexOf((s.data[0] << 8) | s.data[1]) >= 0);
    });
    assert.strictEqual(diag.sent.filter((s) => s.data[1] === 0x00 && s.data[0] === 0xD7).length, 1, 'the make-up is read once');
}))
.then(() => test('the G30\'s ends, were the counter rising toward the BACK: the target mirrors', async () => {
    // fore / aft between 32627 and 33321, height between 32473 and 33217 (15.11.2026)
    const table = { 0xD700: CONFIG, 0xD704: INIT, 0xD702: hall(32627, 32473), 0xD708: MOTOR_OFF, 0xD712: SW_NONE };
    const probe = new L.SeatProbe(new L.SeatLink(linkOf(fakeDiag(table)), quiet), quiet, null);
    await probe.tick();
    assert.strictEqual(probe.exitCounts(0.75), null, 'nothing measured: no target');
    await drive(probe, table, [                                       // back (MINUS) and up (PLUS), end to end
        { slv: 32900, shv: 32700, ms: MINUS, mh: PLUS },
        { slv: 33100, shv: 32950, ms: MINUS, mh: PLUS },
        { slv: 33321, shv: 33217, ms: MINUS, mh: PLUS },
    ]);
    assert.strictEqual(probe.risesToward('slv'), 'back');
    assert.strictEqual(probe.risesToward('shv'), 'up');
    assert.strictEqual(probe.percent('slv'), 100, 'fully back reads 100 % back');
    assert.strictEqual(probe.percent('shv'), 100);
    await drive(probe, table, [{ slv: 32700, shv: 32900 }]);          // a driving position: near the front, part up
    assert.strictEqual(probe.percent('slv'), 11, '(32700 - 32627) / 694 back');
    assert.deepStrictEqual(probe.exitCounts(0.75), { slv: 33148, shv: 32473 }, '75 % back = 32627 + 0.75 x 694; fully down');
    assert.deepStrictEqual(probe.exitCounts(1), { slv: 33321, shv: 32473 });
    await drive(probe, table, [{ slv: 33250, shv: 32900 }]);          // already further back than 75 %
    assert.strictEqual(probe.exitCounts(0.75).slv, 33250, 'never forward of where the seat is');
    assert.strictEqual(probe.countFor('slv', 0), 32627, 'fully forward');
    assert.strictEqual(probe.fraction('lnv', 32390), null, 'the backrest has no known direction');
}))
.then(() => test('the same ends, the counter rising toward the FRONT (the G30, 15.11.2026)', async () => {
    const table = { 0xD700: CONFIG, 0xD704: INIT, 0xD702: hall(33321, 32473), 0xD708: MOTOR_OFF, 0xD712: SW_NONE };
    const probe = new L.SeatProbe(new L.SeatLink(linkOf(fakeDiag(table)), quiet), quiet, null);
    await drive(probe, table, [
        { slv: 33321, shv: 32473 },
        { slv: 33000, shv: 32700, ms: MINUS, mh: PLUS },               // back: the counter falls
        { slv: 32800, shv: 32950, ms: MINUS, mh: PLUS },
        { slv: 32627, shv: 33217, ms: MINUS, mh: PLUS },
        { slv: 33100, shv: 32900 },
    ]);
    assert.strictEqual(probe.risesToward('slv'), 'front');
    assert.deepStrictEqual(probe.exitCounts(0.75), { slv: 32801, shv: 32473 }, '75 % back = 33321 - 0.75 x 694');
}))
.then(() => test('the direction from the seat\'s switch when the motor state is not read; a contradiction drops it', async () => {
    const table = { 0xD700: CONFIG, 0xD704: INIT, 0xD702: hall(32627, 32473), 0xD708: 'nrc', 0xD712: SW_NONE };
    const probe = new L.SeatProbe(new L.SeatLink(linkOf(fakeDiag(table)), quiet), quiet, null);
    await probe.tick();
    for (const v of [32800, 33000, 33321]) {                         // the back switch held, the counter rising
        table[0xD702] = hall(v, 32473); table[0xD712] = SW_SLV_BACK; await probe.tick();
    }
    assert.strictEqual(probe.motor, null, 'D708 refused');
    assert.strictEqual(probe.risesToward('slv'), 'back');
    assert.ok(probe.measured('slv'));
    // the forward switch held and the counter rising too: that contradicts it; nothing is worked out on it
    for (const v of [33330, 33340]) { table[0xD702] = hall(v, 32473); table[0xD712] = SW_SLV_FWD; await probe.tick(); }
    assert.strictEqual(probe.risesToward('slv'), null);
    assert.strictEqual(probe.percent('slv'), null);
}))
.then(() => test('the file sends no write, actuator, routine or session request', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps', 'bre_hub', 'seat_link.js'), 'utf8');
    const calls = src.match(/physical\([^)]*\)/g) || [];
    assert.strictEqual(calls.length, 1, 'one place sends');
    assert.ok(/physical\(FAS, 0x22,/.test(calls[0]), 'and it sends 22 to the seat module');
    assert.ok(!/\b0x(2E|2F|31|10|27|11|14)\b\s*,/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'no other service id in the code');
}))
.then(() => { console.log(passed + ' passed'); })
.catch((e) => { console.error('FAIL ' + e.message); console.error(e.stack); process.exit(1); });
