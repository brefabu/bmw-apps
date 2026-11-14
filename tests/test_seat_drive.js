'use strict';
/**
 * test_seat_drive.js - the real seat moves (apps/bre_hub/seat_drive.js) against a simulated seat module: its Hall
 * counters run while a motor is on, on a simulated clock. Every request is recorded: only 22 reads of the probe's
 * DIDs, 2E D708 for fore / aft and height, and 10 03 / 3E 00 may reach the seat module, and STOP always ends a move.
 *
 *   node tests/test_seat_drive.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const KIT = path.join(__dirname, '..', 'kit', 'runtime');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, isMain, opts) {
    if (req.indexOf('./kit/') === 0) return resolve.call(this, path.join(KIT, req.slice(6)), parent, isMain, opts);
    return resolve.call(this, req, parent, isMain, opts);
};
const L = require('../apps/bre_hub/seat_link');
const Drv = require('../apps/bre_hub/seat_drive');
const S = require('../apps/bre_hub/seats_backend');

const quiet = { info() {}, warn() {}, error() {} };
let passed = 0;
function test(name, fn) {
    return Promise.resolve().then(fn).then(() => { passed++; }, (e) => { e.message = name + ': ' + e.message; throw e; });
}

// the G30's measured ends (15.11.2026): the counters rise toward the front and up (PLUS's way)
const ENDS = { slv: [32627, 33321], shv: [32473, 33217] };
const be16 = (v) => [v >> 8, v & 0xFF];

/**
 * A seat module: o.slv / o.shv where the seat is; o.needSession: 2E refused (NRC 7F) until 10 03;
 * o.wiring: -1 runs the motor the other way from what the learned direction says; o.speed counts per ms.
 */
function fakeModule(o) {
    const m = Object.assign({ slv: 33100, shv: 32900, needSession: false, wiring: 1, speed: 0.07, switchHeld: false,
        stops: ENDS }, o || {});
    m.motor = { slv: 'stop', shv: 'stop' }; m.ext = false; m.sent = []; m.quiet = false;
    m.advance = (ms) => {
        ['slv', 'shv'].forEach((a) => {
            const d = m.motor[a] === 'plus' ? 1 : m.motor[a] === 'minus' ? -1 : 0;
            if (!d) return;
            m[a] = Math.max(m.stops[a][0], Math.min(m.stops[a][1], m[a] + d * m.wiring * m.speed * ms));
        });
    };
    const answer = (sid, data) => {
        if (sid === 0x22) {
            const did = (data[0] << 8) | data[1];
            const pos = (did === 0xD702) ? be16(Math.round(m.slv)).concat(be16(Math.round(m.shv)), be16(32390), new Array(16).fill(0))
                : did === 0xD700 ? [2, 2, 2, 0].concat(new Array(21).fill(0))
                : did === 0xD704 ? [1, 1, 1, 0, 0, 0, 1, 1, 1, 1].concat(new Array(95).fill(0))
                : did === 0xD708 ? ['slv', 'shv'].map((a) => ({ stop: 0, plus: 1, minus: 2 })[m.motor[a]]).concat([0, 3, 3, 3, 3, 3, 0, 0, 0])
                : did === 0xD712 ? [m.switchHeld ? 1 : 0, 0, 0, 0, 2, 2].concat(new Array(13).fill(2)) : null;
            return pos ? [0x62, data[0], data[1]].concat(pos) : [0x7F, 0x22, 0x31];
        }
        if (sid === 0x2E) {
            if (m.needSession && !m.ext) return [0x7F, 0x2E, 0x7F];
            const axis = data[2] === 0 ? 'slv' : data[2] === 1 ? 'shv' : null;
            m.motor[axis] = ['stop', 'plus', 'minus'][data[3]];
            return [0x6E, 0xD7, 0x08];
        }
        if (sid === 0x10) { m.ext = true; return [0x50, 0x03]; }
        if (sid === 0x3E) return [0x7E, 0x00];
        return [0x7F, sid, 0x11];
    };
    m.diag = {
        get quiet() { return m.quiet; }, set quiet(v) { m.quiet = v; },
        async physical(target, sid, data, timeoutMs, accept) {
            m.sent.push({ target: target, sid: sid, data: data.slice() });
            const reply = answer(sid, data);
            assert.ok(!accept || accept(reply), 'the reply matches its request');
            return reply;
        },
    };
    return m;
}

/** The app's parts around a module, on a simulated clock; guard() says whether a move may go on. */
function rig(mod, o) {
    const opt = o || {};
    const link = { diag: mod.diag, available: true };
    const seatLink = new L.SeatLink(link, quiet);
    const probe = new L.SeatProbe(seatLink, quiet, null);
    probe.travel = { slv: ENDS.slv.slice(), shv: ENDS.shv.slice() };
    if (!opt.unlearned) probe.rises = { slv: 'plus', shv: 'plus' };
    const r = { clock: 0, allowed: true, mod: mod, probe: probe };
    r.mover = new Drv.SeatMover({
        probe: probe, seatLink: seatLink, drive: new Drv.SeatDrive(link, quiet), log: quiet,
        guard: () => r.allowed, now: () => r.clock,
        sleep: (ms) => { r.clock += ms; mod.advance(ms); if (opt.during) opt.during(r); return Promise.resolve(); },
    });
    r.backend = new Drv.RealBackend({ probe: probe, mover: r.mover, log: quiet });
    r.backend.refresh = () => probe.tick();
    return r;
}

/** Every request that reached the module is one we allow, and the move ended with STOP on what it drove. */
function onlyAllowed(mod) {
    mod.sent.forEach((s) => {
        assert.strictEqual(s.target, 0x6D);
        if (s.sid === 0x22) assert.ok(L.READS.indexOf((s.data[0] << 8) | s.data[1]) >= 0, 'a listed read');
        else if (s.sid === 0x2E) {
            assert.deepStrictEqual(s.data.slice(0, 2), [0xD7, 0x08], 'only D708');
            assert.ok(s.data[2] === 0 || s.data[2] === 1, 'only fore / aft and height');
            assert.ok(s.data[3] >= 0 && s.data[3] <= 2 && s.data[4] === 100 && s.data.length === 5);
        } else if (s.sid === 0x10) assert.deepStrictEqual(s.data, [0x03]);
        else if (s.sid === 0x3E) assert.deepStrictEqual(s.data, [0x00]);
        else assert.fail('service ' + s.sid.toString(16) + ' sent');
    });
    assert.deepStrictEqual(mod.motor, { slv: 'stop', shv: 'stop' }, 'both motors stopped at the end');
}
const writes = (mod) => mod.sent.filter((s) => s.sid === 0x2E).map((s) => (s.data[2] === 0 ? 'slv ' : 'shv ') + ['stop', 'plus', 'minus'][s.data[3]]);

Promise.resolve()
.then(() => test('getting out: back to 75 % (32801), then fully down (32473); STOP after each axis', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod);
    await r.probe.tick();
    const now = r.backend.status().seats.driver.pos;
    assert.ok(Math.abs(now.fore - (33321 - 33100) / 694) < 1e-9);
    const ok = await r.backend.goTo('driver', S.exitPosition(now, 0.75));
    assert.strictEqual(ok, true, r.mover.reason);
    assert.ok(Math.abs(mod.slv - 32801) <= Drv.TOLERANCE + 12, 'fore / aft at the target: ' + mod.slv);
    assert.ok(mod.shv <= 32473 + Drv.TOLERANCE + 12, 'fully down: ' + mod.shv);
    const w = writes(mod);
    assert.strictEqual(w[0], 'slv minus', 'back is MINUS');
    assert.ok(w.indexOf('slv stop') < w.indexOf('shv minus'), 'one axis at a time: fore / aft first, then height');
    assert.strictEqual(w[w.length - 1], 'shv stop');
    onlyAllowed(mod);
}))
.then(() => test('getting in: up first, then forward, back to where it was', async () => {
    const mod = fakeModule({ slv: 32801, shv: 32473 });
    const r = rig(mod);
    const ok = await r.backend.goTo('driver', { fore: (33321 - 33100) / 694, height: (32900 - 32473) / 744 });
    assert.strictEqual(ok, true, r.mover.reason);
    assert.ok(Math.abs(mod.slv - 33100) <= Drv.TOLERANCE + 12 && Math.abs(mod.shv - 32900) <= Drv.TOLERANCE + 12, mod.slv + ' ' + mod.shv);
    const w = writes(mod);
    assert.strictEqual(w[0], 'shv plus', 'up first');
    assert.ok(w.indexOf('shv stop') < w.indexOf('slv plus'), 'then forward');
    onlyAllowed(mod);
}))
.then(() => test('a module that wants the extended session: 10 03, then the same command again', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900, needSession: true });
    const r = rig(mod);
    const ok = await r.mover.run([['slv', 33000]]);
    assert.strictEqual(ok, true, r.mover.reason);
    const services = mod.sent.filter((s) => s.sid !== 0x22).map((s) => s.sid);
    assert.deepStrictEqual(services.slice(0, 3), [0x2E, 0x10, 0x2E], 'refused, session, again');
    onlyAllowed(mod);
}))
.then(() => test('the motor runs the other way than learned: stopped within a few counts', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900, wiring: -1 });
    const r = rig(mod);
    const ok = await r.mover.run([['slv', 32801]]);
    assert.strictEqual(ok, false);
    assert.strictEqual(r.mover.reason, 'went the wrong way');
    assert.ok(mod.slv - 33100 < 40, 'it went forward only ' + Math.round(mod.slv - 33100) + ' counts');
    onlyAllowed(mod);
}))
.then(() => test('a seat switch touched: stopped', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod, { during: (x) => { if (x.clock > 1000) mod.switchHeld = true; } });
    const ok = await r.mover.run([['slv', 32801]]);
    assert.strictEqual(ok, false);
    assert.strictEqual(r.mover.reason, 'a seat switch was touched');
    assert.ok(r.clock < 1600, 'within a few polls');
    onlyAllowed(mod);
}))
.then(() => test('the car moves (the guard says no): stopped at the next poll', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod, { during: (x) => { if (x.clock > 600) x.allowed = false; } });
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'not allowed now');
    assert.ok(r.clock <= 900);
    onlyAllowed(mod);
}))
.then(() => test('not allowed at the start: nothing written', async () => {
    const mod = fakeModule();
    const r = rig(mod);
    r.allowed = false;
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(writes(mod).length, 0);
}))
.then(() => test('an end stop short of the target: stopped for no progress', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900, stops: { slv: [33000, 33321], shv: ENDS.shv } });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'no progress (end stop?)');
    onlyAllowed(mod);
}))
.then(() => test('the end stop a few counts short of a target at the end of the travel: arrived', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900, stops: { slv: ENDS.slv, shv: [32490, 33217] } });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['shv', 32473]]), true, r.mover.reason);
    assert.strictEqual(Math.round(mod.shv), 32490, 'fully down that day');
    onlyAllowed(mod);
}))
.then(() => test('stop(): the move ends with STOP', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod, { during: (x) => { if (x.clock > 1200) x.mover.stop('stopped'); } });
    assert.strictEqual(await r.mover.run([['slv', 32801], ['shv', 32473]]), false);
    assert.ok(mod.slv > 32801 + 20, 'stopped on the way');
    assert.strictEqual(writes(mod).filter((w) => w.indexOf('shv') === 0).length, 0, 'the next axis never started');
    onlyAllowed(mod);
}))
.then(() => test('no learned direction: no move, nothing written', async () => {
    const mod = fakeModule();
    const r = rig(mod, { unlearned: true });
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'direction not learned');
    assert.strictEqual(writes(mod).length, 0);
}))
.then(() => test('Seat Easy Access on the car\'s switching: out when switched off, kept over a restart, in when started', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bre-drive-'));
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod);
    const positions = new S.Positions(dir, quiet);
    let ee = new S.EasyEntry(r.backend, positions, quiet);
    assert.strictEqual(ee.carStarted('armed', true), false, 'started while IDLE: nothing');
    assert.strictEqual(ee.carStopped('armed', false), false, 'not parked: nothing');
    assert.strictEqual(ee.carStopped('armed', true), true);
    await new Promise((res) => { const t = setInterval(() => { if (ee.state !== 'MOVING_OUT') { clearInterval(t); res(); } }, 5); });
    assert.strictEqual(ee.state, 'OUT', r.mover.reason);
    assert.ok(Math.abs(mod.slv - 32801) <= Drv.TOLERANCE + 12 && mod.shv <= 32473 + 20);
    // the app restarts while the car is off: still OUT, the driving position kept
    ee = new S.EasyEntry(r.backend, new S.Positions(dir, quiet), quiet);
    assert.strictEqual(ee.state, 'OUT');
    assert.strictEqual(ee.carStarted('armed', true), true);
    await new Promise((res) => { const t = setInterval(() => { if (ee.state !== 'MOVING_IN') { clearInterval(t); res(); } }, 5); });
    assert.strictEqual(ee.state, 'IDLE', r.mover.reason);
    assert.ok(Math.abs(mod.slv - 33100) <= Drv.TOLERANCE + 12 && Math.abs(mod.shv - 32900) <= Drv.TOLERANCE + 12, mod.slv + ' ' + mod.shv);
    assert.strictEqual(new S.Positions(dir, quiet).flag('driver', 'out'), false, 'back in: not OUT after a restart');
    assert.strictEqual(ee.carStopped('demo', true) && false, false);
    onlyAllowed(mod);
}))
.then(() => test('no position (the probe never saw the seat): out is not started', async () => {
    const mod = fakeModule();
    const r = rig(mod);
    r.probe.travel = {};                                              // ends not measured
    const ee = new S.EasyEntry(r.backend, new S.Positions(fs.mkdtempSync(path.join(os.tmpdir(), 'bre-drive-')), quiet), quiet);
    ee.carStopped('armed', true);
    await new Promise((res) => setTimeout(res, 30));
    assert.strictEqual(ee.state, 'IDLE');
    assert.strictEqual(ee.events[0].key, 'ee.noPosition');
    assert.strictEqual(writes(mod).length, 0);
}))
.then(() => test('the file writes only D708, for fore / aft and height', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps', 'bre_hub', 'seat_drive.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.deepStrictEqual(Object.keys(Drv.MOTOR), ['slv', 'shv']);
    assert.ok(/\[0xD7, 0x08, MOTOR\[axis\], ACTION\[action\], PWM\]/.test(src), 'the one 2E request');
    const sids = (src.match(/_send\(0x[0-9A-F]{2}/g) || []).map((x) => x.slice(6)).sort();
    assert.deepStrictEqual(Array.from(new Set(sids)), ['0x10', '0x2E', '0x3E'], 'and nothing else is sent from here');
    assert.ok(!/0xD7, 0x22|0x31|0x27|0x2F|0x14|0x11/.test(src), 'no counter reset, routine, security access, actuator, DTC clear or reset');
}))
.then(() => { console.log(passed + ' passed'); process.exit(0); })
.catch((e) => { console.error('FAIL ' + e.message); console.error(e.stack); process.exit(1); });
