'use strict';
/**
 * test_seat_drive.js - the real seat moves (apps/bre_hub/seat_drive.js) against a simulated seat module whose Hall
 * counters run while a motor is on, on a simulated clock. Moves go by the seat's measured SPEED, in timed pulses:
 * nothing is read while a motor runs. Every request is recorded: only 22 reads of the probe's DIDs, 2E D708 for
 * fore / aft and height, 10 03 / 10 01 and 3E 00 may reach the seat module, and STOP always ends a pulse.
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
const SPEED = 0.07;                                    // counts per ms: ~70 per second
const be16 = (v) => [v >> 8, v & 0xFF];

/**
 * A seat module. o.slv / o.shv: where the seat is; o.speed: counts per ms (the real one, which the app may not
 * know); o.wiring -1: the motor runs the other way from what the learned direction says; o.silent: motor commands
 * (not STOP) that get no answer, o.silentDoes: and still run the motor; o.refuse: an NRC for every PLUS / MINUS;
 * o.ignore: commands answered but the motor never runs; o.sessionRefused: 'refused' | 'timeout'.
 */
function fakeModule(o) {
    const m = Object.assign({ slv: 33100, shv: 32900, speed: SPEED, wiring: 1, switchHeld: false, stops: ENDS,
        silent: 0, silentDoes: false, refuse: null, ignore: false, sessionRefused: null, oneMotor: false }, o || {});
    m.motor = { slv: 'stop', shv: 'stop' }; m.ext = false; m.sent = []; m.quiet = false;
    m.advance = (ms) => {
        ['slv', 'shv'].forEach((a) => {
            const d = m.motor[a] === 'plus' ? 1 : m.motor[a] === 'minus' ? -1 : 0;
            if (!d) return;
            m[a] = Math.max(m.stops[a][0], Math.min(m.stops[a][1], m[a] + d * m.wiring * m.speed * ms));
        });
    };
    const answer = (sid, data) => {
        if (sid === 0x22 && data.length > 2) {
            // several identifiers in one read: 62 <DID> <data> <DID> <data> ...
            let out = [0x62];
            for (let i = 0; i < data.length; i += 2) {
                const one = answer(0x22, [data[i], data[i + 1]]);
                if (one[0] !== 0x62) return one;
                out = out.concat(one.slice(1));
            }
            return out;
        }
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
            const axis = data[2] === 0 ? 'slv' : data[2] === 1 ? 'shv' : null;
            const action = ['stop', 'plus', 'minus'][data[3]];
            if (action !== 'stop') {
                if (m.refuse) return [0x7F, 0x2E, m.refuse];
                const other = axis === 'slv' ? 'shv' : 'slv';
                if (m.oneMotor && m.motor[other] !== 'stop') return [0x7F, 0x2E, 0x22];     // one motor at a time only
                if (m.silent > 0) { m.silent--; if (m.silentDoes) m.motor[axis] = action; return null; }
                if (m.ignore) return [0x6E, 0xD7, 0x08];
            }
            m.motor[axis] = action;
            return [0x6E, 0xD7, 0x08];
        }
        if (sid === 0x10) {
            if (m.sessionRefused) return m.sessionRefused === 'timeout' ? null : [0x7F, 0x10, 0x22];
            m.ext = data[0] === 0x03;
            if (!m.ext) m.motor = { slv: 'stop', shv: 'stop' };       // the default session ends tester control
            return [0x50, data[0]];
        }
        if (sid === 0x3E) return [0x7E, 0x00];
        return [0x7F, sid, 0x11];
    };
    m.diag = {
        get quiet() { return m.quiet; }, set quiet(v) { m.quiet = v; },
        async physical(target, sid, data, timeoutMs, accept, opts) {
            m.sent.push({ target: target, sid: sid, data: data.slice() });
            const running = m.motor.slv !== 'stop' || m.motor.shv !== 'stop';
            // the point of the speed: nothing is read while a motor runs
            if (sid === 0x22) assert.ok(!running, 'a read while a motor runs: 22 ' + data.map((x) => x.toString(16)).join(' '));
            // a PLUS / MINUS is waited for briefly (the pulse is timed anyway); a STOP longer
            if (sid === 0x2E) assert.ok(data[3] === 0 ? timeoutMs >= 3000 : timeoutMs <= 300, 'command waits: ' + data[3] + ' ' + timeoutMs);
            const reply = answer(sid, data);
            if (reply === null) return null;
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
    const probe = new L.SeatProbe(seatLink, quiet, opt.dir || null);
    probe.travel = { slv: ENDS.slv.slice(), shv: ENDS.shv.slice() };
    if (!opt.unlearned) probe.rises = { slv: 'plus', shv: 'plus' };
    if (!opt.noSpeed) probe.speeds = { slv: { plus: opt.speed || SPEED, minus: opt.speed || SPEED }, shv: { plus: opt.speed || SPEED, minus: opt.speed || SPEED } };
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

/** Every request that reached the module is one we allow, and both motors are stopped at the end. */
function onlyAllowed(mod) {
    mod.sent.forEach((s) => {
        assert.strictEqual(s.target, 0x6D);
        if (s.sid === 0x22) for (let i = 0; i < s.data.length; i += 2) assert.ok(L.READS.indexOf((s.data[i] << 8) | s.data[i + 1]) >= 0, 'a listed read');
        else if (s.sid === 0x2E) {
            assert.deepStrictEqual(s.data.slice(0, 2), [0xD7, 0x08], 'only D708');
            assert.ok(s.data[2] === 0 || s.data[2] === 1, 'only fore / aft and height');
            assert.ok(s.data[3] >= 0 && s.data[3] <= 2 && s.data[4] === 100 && s.data.length === 5);
        } else if (s.sid === 0x10) assert.ok(s.data.length === 1 && (s.data[0] === 0x03 || s.data[0] === 0x01), 'only 10 03 / 10 01');
        else if (s.sid === 0x3E) assert.deepStrictEqual(s.data, [0x00]);
        else assert.fail('service ' + s.sid.toString(16) + ' sent');
    });
    assert.deepStrictEqual(mod.motor, { slv: 'stop', shv: 'stop' }, 'both motors stopped at the end');
}
const writes = (mod) => mod.sent.filter((s) => s.sid === 0x2E).map((s) => (s.data[2] === 0 ? 'slv ' : 'shv ') + ['stop', 'plus', 'minus'][s.data[3]]);
const sessions = (mod) => mod.sent.filter((s) => s.sid === 0x10).map((s) => s.data[0]);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

Promise.resolve()
.then(() => test('the speed test: each axis back / down then forward / up for 1 s, the speeds kept', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bre-speed-'));
    const mod = fakeModule({ slv: 33000, shv: 32800 });
    const r = rig(mod, { noSpeed: true, dir: dir });
    assert.strictEqual(await r.mover.measureSpeed(), true, r.mover.reason);
    assert.deepStrictEqual(writes(mod), ['slv minus', 'slv stop', 'slv plus', 'slv stop', 'shv minus', 'shv stop', 'shv plus', 'shv stop']);
    ['slv', 'shv'].forEach((a) => ['plus', 'minus'].forEach((k) => assert.ok(near(r.probe.speed(a, k), SPEED, 0.003), a + ' ' + k + ' ' + r.probe.speed(a, k))));
    assert.ok(near(mod.slv, 33000, 3) && near(mod.shv, 32800, 3), 'it ends where it began');
    assert.deepStrictEqual(sessions(mod), [0x03, 0x01], 'in the extended session, the default one after');
    assert.deepStrictEqual(r.mover.tested.ok, true);
    const again = new L.SeatProbe(new L.SeatLink({ diag: mod.diag, available: true }, quiet), quiet, dir);
    assert.ok(near(again.speed('slv', 'minus'), SPEED, 0.003), 'the speeds survive a restart');
    onlyAllowed(mod);
}))
.then(() => test('the speed test learns the direction when none was learned', async () => {
    const mod = fakeModule();
    const r = rig(mod, { noSpeed: true, unlearned: true });
    assert.strictEqual(await r.mover.measureSpeed(), true, r.mover.reason);
    assert.deepStrictEqual(r.probe.rises, { slv: 'plus', shv: 'plus' });
    assert.strictEqual(r.probe.risesToward('slv'), 'front');
}))
.then(() => test('the speed test finds the learned direction wrong: dropped, stopped', async () => {
    const mod = fakeModule({ wiring: -1 });
    const r = rig(mod, { noSpeed: true });
    assert.strictEqual(await r.mover.measureSpeed(), false);
    assert.ok(/other way than learned/.test(r.mover.reason), r.mover.reason);
    assert.strictEqual(r.probe.rises.slv, undefined);
    assert.strictEqual(writes(mod).length, 2, 'one pulse and its STOP');
    onlyAllowed(mod);
}))
.then(() => test('the speed test on a seat that does not move: stopped, and it says so', async () => {
    const mod = fakeModule({ ignore: true });
    const r = rig(mod, { noSpeed: true });
    assert.strictEqual(await r.mover.measureSpeed(), false);
    assert.strictEqual(r.mover.reason, 'the seat did not move (slv minus)');
    assert.strictEqual(r.mover.tested.ok, false);
}))
.then(() => test('getting out by the speed: back to 75 % (32801), then fully down, in a few pulses, nothing read while moving', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod);
    await r.probe.tick();
    const now = r.backend.status().seats.driver.pos;
    assert.strictEqual(await r.backend.goTo('driver', S.exitPosition(now, 0.75)), true, r.mover.reason);
    assert.ok(near(mod.slv, 32801, Drv.TOLERANCE), 'fore / aft at the target: ' + mod.slv);
    assert.ok(mod.shv <= 32473 + Drv.TOLERANCE, 'fully down: ' + mod.shv);
    const w = writes(mod);
    assert.deepStrictEqual(w.slice(0, 2), ['slv minus', 'shv minus'], 'both axes at once: back and down together');
    assert.ok(w.filter((x) => x === 'slv minus').length <= Drv.MAX_PULSES);
    ['slv', 'shv'].forEach((a) => assert.strictEqual(w.filter((x) => x === a + ' stop').length, w.filter((x) => x === a + ' minus' || x === a + ' plus').length, a + ': every pulse ends with STOP'));
    onlyAllowed(mod);
}))
.then(() => test('getting out coarse (Easy Access): one pulse per axis, within ~1 cm, fully down by the end stop', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod);
    await r.probe.tick();
    const now = r.backend.status().seats.driver.pos;
    assert.strictEqual(await r.backend.goTo('driver', S.exitPosition(now, 0.75), { coarse: true }), true, r.mover.reason);
    assert.deepStrictEqual(writes(mod), ['slv minus', 'shv minus', 'slv stop', 'shv stop'], 'one pulse each, together, each stopped at its time');
    assert.ok(near(mod.slv, 32801, Drv.COARSE_TOL), String(mod.slv));
    assert.strictEqual(Math.round(mod.shv), 32473, 'fully down: the pulse ran into the end stop');
    onlyAllowed(mod);
}))
.then(() => test('a position read just now: the move starts without another read', async () => {
    const mod = fakeModule({ slv: 33100 });
    const r = rig(mod);
    await r.probe.tick();
    const before = mod.sent.length;
    assert.strictEqual(await r.mover.run([['slv', 32801]]), true, r.mover.reason);
    const sent = mod.sent.slice(before).map((s) => s.sid.toString(16) + (s.sid === 0x22 ? ' ' + s.data[1].toString(16) : ''));
    assert.deepStrictEqual(sent.slice(0, 2), ['10', '2e'], 'the session, then the first pulse straight away');
    onlyAllowed(mod);
}))
.then(() => test('getting out from an old last position: it starts from it, without a read first', async () => {
    const mod = fakeModule({ slv: 33100 });
    const r = rig(mod);
    await r.probe.tick();
    r.probe.hallAt -= 120000;                                         // read two minutes ago
    const before = mod.sent.length;
    assert.strictEqual(await r.mover.run([['slv', 32801]], { coarse: true }), true, r.mover.reason);
    const first = mod.sent.slice(before).filter((s) => s.sid !== 0x10)[0];
    assert.strictEqual(first.sid, 0x2E, 'the first pulse before any read');
    onlyAllowed(mod);
}))
.then(() => test('getting in (toward the wheel) from an old position: one read first', async () => {
    const mod = fakeModule({ slv: 32801 });
    const r = rig(mod);
    await r.probe.tick();
    r.probe.hallAt -= 10000;
    const before = mod.sent.length;
    assert.strictEqual(await r.mover.run([['slv', 33100]]), true, r.mover.reason);
    const first = mod.sent.slice(before).filter((s) => s.sid !== 0x10)[0];
    assert.deepStrictEqual([first.sid, first.data[1]], [0x22, 0x02], 'the position read before moving toward the wheel');
    onlyAllowed(mod);
}))
.then(() => test('getting out from a stale position (the seat further back than read): back only, never toward the wheel', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod);
    await r.probe.tick();                                             // read at 33100 ...
    mod.slv = 32700;                                                  // ... then moved back by hand, unseen
    assert.strictEqual(await r.mover.run([['slv', 32801]], { coarse: true }), true, r.mover.reason);
    assert.ok(writes(mod).indexOf('slv plus') < 0, 'nothing toward the wheel: ' + writes(mod).join(', '));
    assert.ok(mod.slv <= 32700, 'not forward of where it was: ' + mod.slv);
    onlyAllowed(mod);
}))
.then(() => test('getting out, the check not read: taken as there, at the position the speed gives', async () => {
    const mod = fakeModule({ slv: 33100 });
    let pulses = 0;
    const r = rig(mod);
    await r.probe.tick();
    const physical = mod.diag.physical;
    mod.diag.physical = async function (target, sid, data) {
        if (sid === 0x2E && data[3] !== 0) pulses++;
        if (sid === 0x22 && data[1] === 0x02 && pulses > 0) return null;   // every check after the pulse goes unanswered
        return physical.apply(this, arguments);
    };
    assert.strictEqual(await r.mover.run([['slv', 32801]], { coarse: true }), true, r.mover.reason);
    assert.ok(near(r.probe.hall.slv, 32801, Drv.COARSE_TOL), 'the position worked out: ' + r.probe.hall.slv);
    assert.ok(near(mod.slv, 32801, Drv.COARSE_TOL), 'and the seat is there: ' + mod.slv);
    // a precise move does not guess: it stops
    const mod2 = fakeModule({ slv: 32801 });
    const r2 = rig(mod2);
    await r2.probe.tick();
    const physical2 = mod2.diag.physical; let p2 = 0;
    mod2.diag.physical = async function (target, sid, data) {
        if (sid === 0x2E && data[3] !== 0) p2++;
        if (sid === 0x22 && data[1] === 0x02 && p2 > 0) return null;
        return physical2.apply(this, arguments);
    };
    assert.strictEqual(await r2.mover.run([['slv', 33100]]), false);
    assert.strictEqual(r2.mover.reason, 'position not read');
}))
.then(() => test('getting in after the seat was moved forward unseen (the M1 button): never pushed past the target', async () => {
    const mod = fakeModule({ slv: 32801 });
    let most = 0;
    const r = rig(mod, { during: () => { most = Math.max(most, mod.slv); } });
    await r.probe.tick();                                             // read at 32801 (getting out) ...
    r.probe.hallAt -= 30000;
    mod.slv = 33050;                                                  // ... then M1 brought it forward, unseen
    assert.strictEqual(await r.mover.run([['slv', 33100]]), true, r.mover.reason);
    assert.ok(near(mod.slv, 33100, Drv.TOLERANCE), String(mod.slv));
    assert.ok(most <= 33100 + Drv.TOLERANCE, 'never past the driving position toward the wheel: ' + Math.round(most));
    onlyAllowed(mod);
}))
.then(() => test('a check after a pulse is ONE request: the position and the switches together', async () => {
    const mod = fakeModule({ slv: 33100 });
    const r = rig(mod);
    await r.probe.tick();
    const before = mod.sent.length;
    assert.strictEqual(await r.mover.run([['slv', 32801]], { coarse: true }), true, r.mover.reason);
    const reads = mod.sent.slice(before).filter((s) => s.sid === 0x22);
    assert.ok(reads.length >= 1 && reads.every((s) => s.data.length === 4 && s.data[1] === 0x02 && s.data[3] === 0x12), 'only 22 D702 D712');
    assert.strictEqual(r.probe.seat.multi, true);
    onlyAllowed(mod);
}))
.then(() => test('tester present only when the seat module was idle 2 s, and never two queued', async () => {
    const mod = fakeModule();
    const link = { diag: mod.diag, available: true };
    const drive = new Drv.SeatDrive(link, quiet);
    mod.diag.lastAt = {};
    assert.strictEqual((await drive.begin()).ok, true);
    drive.keep(false); drive.extended = true;                     // (no timer: ticks by hand)
    mod.diag.lastAt[0x6D] = Date.now();
    assert.strictEqual(drive.keepTick(), false, 'a request just went: the session is kept by it');
    mod.diag.lastAt[0x6D] = Date.now() - 3000;
    assert.strictEqual(drive.keepTick(), true, 'idle: one 3E');
    assert.strictEqual(drive.keepTick(), false, 'and not a second while it is on its way');
    await new Promise((res) => setTimeout(res, 5));
    assert.strictEqual(mod.sent.filter((s) => s.sid === 0x3E).length, 1);
}))
.then(() => test('the background watch reads only the position: one request', async () => {
    const mod = fakeModule({ slv: 33000 });
    const r = rig(mod);
    await r.probe.tick();
    const before = mod.sent.length;
    mod.slv = 33050;
    assert.strictEqual(await r.probe.readPosition(), true);
    assert.deepStrictEqual(mod.sent.slice(before).map((s) => s.data[1]), [0x02], 'only 22 D702');
    assert.strictEqual(r.probe.hall.slv, 33050);
    assert.ok(r.probe.fresh(1000));
}))
.then(() => test('together: as long as the longest axis, not both added', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod);
    await r.probe.tick();
    assert.strictEqual(await r.mover.run([['slv', 32801], ['shv', 32473]], { coarse: true }), true, r.mover.reason);
    const longest = (32900 - 32473) / SPEED * 1.15;                  // the height, to its end stop
    assert.ok(r.clock < longest + 1500, 'took ' + r.clock + ' ms; the longest axis alone ' + Math.round(longest));
    assert.strictEqual(r.mover.parallel, true);
}))
.then(() => test('a module that runs one motor at a time: one axis after the other from then on', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900, oneMotor: true });
    const r = rig(mod);
    await r.probe.tick();
    assert.strictEqual(await r.mover.run([['slv', 32801], ['shv', 32473]], { coarse: true }), true, r.mover.reason);
    assert.strictEqual(r.mover.parallel, false, 'remembered');
    assert.ok(near(mod.slv, 32801, Drv.COARSE_TOL) && mod.shv <= 32473 + Drv.COARSE_TOL, mod.slv + ' ' + mod.shv);
    const w = writes(mod);
    assert.strictEqual(w[0], 'slv minus');
    const n = w.length;
    assert.strictEqual(await r.mover.run([['shv', 32700], ['slv', 33000]]), true, r.mover.reason);
    const w2 = writes(mod).slice(n);
    assert.ok(w2.lastIndexOf('shv stop') < w2.indexOf('slv plus'), 'one at a time without asking again: ' + w2.join(', '));
    onlyAllowed(mod);
}))
.then(() => test('the session asked again while the link is busy (right after the engine started)', async () => {
    const mod = fakeModule();
    let busy = 2;
    const physical = mod.diag.physical;
    mod.diag.physical = async function (target, sid, data) {
        if (sid === 0x10 && data[0] === 0x03 && busy-- > 0) throw new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED');
        return physical.apply(this, arguments);
    };
    const drive = new Drv.SeatDrive({ diag: mod.diag, available: true }, quiet, { sleep: () => Promise.resolve() });
    const s = await drive.begin();
    assert.strictEqual(s.ok, true, 'opened on the third try');
    drive.keep(false);
}))
.then(() => test('getting in: up first, then forward, back to where it was', async () => {
    const mod = fakeModule({ slv: 32801, shv: 32473 });
    const r = rig(mod);
    assert.strictEqual(await r.backend.goTo('driver', { fore: (33321 - 33100) / 694, height: (32900 - 32473) / 744 }), true, r.mover.reason);
    assert.ok(near(mod.slv, 33100, Drv.TOLERANCE) && near(mod.shv, 32900, Drv.TOLERANCE), mod.slv + ' ' + mod.shv);
    const w = writes(mod);
    assert.deepStrictEqual(w.slice(0, 2), ['shv plus', 'slv plus'], 'up and forward together');
    onlyAllowed(mod);
}))
.then(() => test('a speed off by a third: the correcting pulses still get there, and the kept speed learns', async () => {
    const mod = fakeModule({ slv: 33100, shv: 32900, speed: 0.05 });
    const r = rig(mod, { speed: SPEED });
    assert.strictEqual(await r.mover.run([['slv', 32801]]), true, r.mover.reason);
    assert.ok(near(mod.slv, 32801, Drv.TOLERANCE), String(mod.slv));
    assert.ok(r.probe.speed('slv', 'minus') < SPEED, 'learnt slower: ' + r.probe.speed('slv', 'minus'));
    onlyAllowed(mod);
}))
.then(() => test('the first pulse falls short rather than past', async () => {
    const mod = fakeModule({ slv: 33100 });
    let after1 = null;
    const r = rig(mod, { during: (x) => { if (after1 === null && writes(mod).length === 2) after1 = mod.slv; } });
    await r.mover.run([['slv', 32801]]);
    assert.ok(after1 > 32801, 'still short of the target after the first pulse: ' + after1);
}))
.then(() => test('no speed measured: no move, nothing written', async () => {
    const mod = fakeModule();
    const r = rig(mod, { noSpeed: true });
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'measure the seat speed first (Seat module)');
    assert.strictEqual(writes(mod).length, 0);
}))
.then(() => test('no learned direction: no move, nothing written', async () => {
    const mod = fakeModule();
    const r = rig(mod, { unlearned: true });
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'direction not learned');
    assert.strictEqual(writes(mod).length, 0);
}))
.then(() => test('the motor runs the other way than learned: one pulse, then stopped and the direction dropped', async () => {
    const mod = fakeModule({ slv: 33100, wiring: -1 });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.ok(/wrong way/.test(r.mover.reason), r.mover.reason);
    assert.strictEqual(r.probe.rises.slv, undefined);
    assert.deepStrictEqual(writes(mod), ['slv minus', 'slv stop']);
    onlyAllowed(mod);
}))
.then(() => test('the car moves (the guard says no) during a pulse: STOP at once', async () => {
    const mod = fakeModule({ slv: 33100 });
    let at = null;
    const r = rig(mod, { during: (x) => { if (x.clock > 600 && x.allowed) { x.allowed = false; at = x.clock; } } });
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'not allowed now');
    assert.ok(r.clock - at <= 60, 'stopped within one check: ' + (r.clock - at) + ' ms');
    onlyAllowed(mod);
}))
.then(() => test('not allowed at the start: nothing at all is sent', async () => {
    const mod = fakeModule();
    const r = rig(mod);
    r.allowed = false;
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(mod.sent.length, 0);
}))
.then(() => test('stop() during a pulse: STOP at once', async () => {
    const mod = fakeModule({ slv: 33100 });
    const r = rig(mod, { during: (x) => { if (x.clock > 1000) x.mover.stop('stopped'); } });
    assert.strictEqual(await r.mover.run([['slv', 32801], ['shv', 32473]]), false);
    assert.ok(mod.slv > 32801 + 20, 'stopped on the way');
    const w = writes(mod);
    assert.deepStrictEqual(w.filter((x) => !/ stop$/.test(x)), ['slv minus', 'shv minus'], 'one pulse each, no more after Stop');
    assert.ok(w.indexOf('slv stop') > 0 && w.indexOf('shv stop') > 0, 'both stopped');
    onlyAllowed(mod);
}))
.then(() => test('the module refuses the command: STOP, and why', async () => {
    const mod = fakeModule({ refuse: 0x22 });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'command refused: conditions not correct');
    onlyAllowed(mod);
}))
.then(() => test('a command never answered and nothing moved: stopped, "the seat did not move"', async () => {
    const mod = fakeModule({ silent: 1000 });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'the seat did not move');
    onlyAllowed(mod);
}))
.then(() => test('a command never answered but obeyed: timed from when it was sent, and it gets there', async () => {
    const mod = fakeModule({ slv: 33100, silent: 1000, silentDoes: true });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['slv', 32801]]), true, r.mover.reason);
    assert.ok(near(mod.slv, 32801, Drv.TOLERANCE), String(mod.slv));
    onlyAllowed(mod);
}))
.then(() => test('a seat switch held after a pulse: stopped', async () => {
    const mod = fakeModule({ slv: 33100 });
    const r = rig(mod, { during: (x) => { if (x.clock > 1000) mod.switchHeld = true; } });
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(r.mover.reason, 'a seat switch was touched');
    onlyAllowed(mod);
}))
.then(() => test('the end stop a few counts short of a target at the end of the travel: arrived', async () => {
    const mod = fakeModule({ shv: 32900, stops: { slv: ENDS.slv, shv: [32490, 33217] } });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['shv', 32473]]), true, r.mover.reason);
    assert.strictEqual(Math.round(mod.shv), 32490, 'fully down that day');
    onlyAllowed(mod);
}))
.then(() => test('no extended session (refused or unanswered): no motor command at all, and why', async () => {
    for (const how of ['refused', 'timeout']) {
        const mod = fakeModule({ sessionRefused: how });
        const r = rig(mod);
        assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
        assert.ok(/^extended session: /.test(r.mover.reason), r.mover.reason);
        assert.strictEqual(writes(mod).length, 0, how + ': nothing written');
    }
}))
.then(() => test('a move that fails still ends in the default session', async () => {
    const mod = fakeModule({ wiring: -1 });
    const r = rig(mod);
    assert.strictEqual(await r.mover.run([['slv', 32801]]), false);
    assert.strictEqual(sessions(mod).pop(), 0x01);
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
    assert.ok(near(mod.slv, 32801, Drv.TOLERANCE) && mod.shv <= 32473 + Drv.TOLERANCE, mod.slv + ' ' + mod.shv);
    assert.strictEqual(new S.Positions(dir, quiet).flag('driver.real', 'out'), true, 'the OUT of the real seat, kept apart from the demo');
    assert.ok(new S.Positions(dir, quiet).get('driver.real', 'drive') && !new S.Positions(dir, quiet).get('driver', 'drive'));
    ee = new S.EasyEntry(r.backend, new S.Positions(dir, quiet), quiet);
    assert.strictEqual(ee.state, 'OUT', 'still OUT after a restart');
    assert.strictEqual(ee.carStarted('armed', true), true);
    await new Promise((res) => { const t = setInterval(() => { if (ee.state !== 'MOVING_IN') { clearInterval(t); res(); } }, 5); });
    assert.strictEqual(ee.state, 'IDLE', r.mover.reason);
    assert.ok(near(mod.slv, 33100, Drv.TOLERANCE) && near(mod.shv, 32900, Drv.TOLERANCE), mod.slv + ' ' + mod.shv);
    assert.strictEqual(new S.Positions(dir, quiet).flag('driver.real', 'out'), false, 'back in: not OUT after a restart');
    onlyAllowed(mod);
}))
.then(() => test('position 1 from M1: kept as the module counters, and gone back to exactly when the ends measured change', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bre-drive-'));
    const mod = fakeModule({ slv: 33100, shv: 32900 });
    const r = rig(mod);
    await r.probe.tick();
    const ee = new S.EasyEntry(r.backend, new S.Positions(dir, quiet), quiet);
    assert.strictEqual(await ee.savePosition('m1'), true);
    const kept = new S.Positions(dir, quiet).get('driver.real', 'mem1');
    assert.deepStrictEqual(kept.counts, { slv: 33100, shv: 32900 });
    assert.strictEqual(kept.from, 'm1');
    // the rail's back end seen 100 counts further later: the same share is now 32 counts off; the counters are not
    r.probe.travel.slv[0] -= 100;
    mod.slv = 32700; mod.shv = 32473;
    await r.probe.tick();
    assert.strictEqual(await r.backend.goTo('driver', kept), true, r.mover.reason);
    assert.ok(near(mod.slv, 33100, Drv.TOLERANCE) && near(mod.shv, 32900, Drv.TOLERANCE), mod.slv + ' ' + mod.shv);
    // counters outside the ends measured: kept within them
    mod.slv = 32700; await r.probe.tick();
    assert.strictEqual(await r.backend.goTo('driver', { fore: 0, height: kept.height, counts: { slv: 40000, shv: 32900 } }), true, r.mover.reason);
    assert.ok(mod.slv <= 33321 + Drv.TOLERANCE, 'not past the front end measured: ' + mod.slv);
    onlyAllowed(mod);
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
