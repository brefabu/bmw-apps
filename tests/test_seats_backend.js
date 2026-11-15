'use strict';
/**
 * Tests for apps/bre_hub/seats_backend.js: the demo backend and the Easy Entry state machine.
 * No car, no kit: node tests/test_seats_backend.js (Node 8 or newer).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../apps/bre_hub/seats_backend');

const quiet = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bre-seats-'));
    let passed = 0;
    const ok = (name) => { passed++; console.log('ok - ' + name); };

    // 1. goTo reaches its target
    let b = S.createBackend('demo', quiet);
    const done = await b.goTo('driver', { fore: 0.4, height: 0.5, back: 0.3 });
    assert.strictEqual(done, true);
    assert.ok(Math.abs(b.status().seats.driver.pos.fore - 0.4) < 1e-9);
    ok('goTo reaches the target');

    // 2. a jog stops by itself when it is not repeated (dead man)
    const before = b.status().seats.driver.pos.fore;
    b.jog('driver', 'fore', 1);
    await wait(700);
    const after = b.status().seats.driver.pos.fore;
    assert.ok(after > before, 'moved');
    assert.strictEqual(b.status().seats.driver.moving, false, 'stopped without repeats');
    assert.ok(after - before < 0.15, 'moved only while held');
    ok('jog stops without repeats');

    // 3. stop() ends a goTo and resolves it false
    const p = b.goTo('driver', { fore: 1 });
    await wait(100);
    b.stop('driver');
    assert.strictEqual(await p, false);
    ok('stop ends a move');
    b.close();

    // 4. Seat Easy Access: door open with the ignition off -> back to 75 % and fully down; door shut with
    //    the ignition on -> back where it was
    b = S.createBackend('demo', quiet);
    const pos = new S.Positions(dir, quiet);
    const ee = new S.EasyEntry(b, pos, quiet);
    const drive = b.status().seats.driver.pos;
    assert.deepStrictEqual(S.exitPosition({ fore: 0.35, height: 0.5, back: 0.3 }, 0.75), { fore: 0.75, height: 0, back: 0.3 });
    assert.strictEqual(S.exitPosition({ fore: 0.9, height: 0.2, back: 0.1 }, 0.75).fore, 0.9, 'never forward');
    ee.onCar({ doorOpen: true, ignition: false, parked: true }, 'demo');
    assert.strictEqual(ee.state, 'MOVING_OUT');
    await wait(2700);
    assert.strictEqual(ee.state, 'OUT');
    let at = b.status().seats.driver.pos;
    assert.ok(Math.abs(at.fore - 0.75) < 1e-9 && at.height === 0 && at.back === drive.back, 'back 75 %, fully down, backrest kept');
    ee.onCar({ doorOpen: false, ignition: true, parked: true }, 'demo');
    assert.strictEqual(ee.state, 'MOVING_IN');
    await wait(2700);
    assert.strictEqual(ee.state, 'IDLE');
    at = b.status().seats.driver.pos;
    assert.ok(Math.abs(at.fore - drive.fore) < 1e-9 && Math.abs(at.height - drive.height) < 1e-9, 'back where it was');
    ok('Seat Easy Access: 75 % back and down, then back');

    // 4b. the offset is a setting
    ee.setOffset(50);
    ee.onCar({ doorOpen: true, ignition: false, parked: true }, 'demo');
    await wait(2700);
    assert.strictEqual(ee.state, 'OUT');
    assert.ok(Math.abs(b.status().seats.driver.pos.fore - 0.5) < 1e-9, 'back to 50 %');
    ee.onCar({ doorOpen: false, ignition: true, parked: true }, 'demo');
    await wait(2700);
    assert.strictEqual(ee.state, 'IDLE');
    ee.setOffset(75);
    ok('the offset can be changed');

    // 5. the car moving stops an automatic move
    ee.onCar({ doorOpen: true, ignition: false, parked: true }, 'demo');
    assert.strictEqual(ee.state, 'MOVING_OUT');
    ee.onCar({ parked: false }, 'demo');
    assert.strictEqual(ee.state, 'STOPPED');
    assert.strictEqual(b.status().seats.driver.moving, false);
    ee.reset();
    assert.strictEqual(ee.state, 'IDLE');
    ok('moving stops Easy Access; reset makes it ready again');

    // 6. off: nothing happens
    const ee2 = new S.EasyEntry(b, pos, quiet);
    ee2.onCar({ doorOpen: true, ignition: false, parked: true }, 'off');
    assert.strictEqual(ee2.state, 'IDLE');
    ok('off does nothing');

    // 7. positions survive a restart
    assert.ok(new S.Positions(dir, quiet).get('driver', 'drive'));
    ok('positions are kept');

    // 8. position 1: saved where the seat is; the car started brings the seat there, not where it was at the stop
    await b.goTo('driver', { fore: 0.2, height: 0.7, back: 0.3 });
    assert.strictEqual(ee.hasPosition(), false);
    assert.strictEqual(await ee.savePosition(), true);
    assert.strictEqual(ee.hasPosition(), true);
    assert.strictEqual(ee.events[0].key, 'ee.saved');
    await b.goTo('driver', { fore: 0.4, height: 0.4, back: 0.3 });   // someone else drove it like this
    assert.strictEqual(ee.carStopped('demo', true), true);
    await wait(2700);
    assert.strictEqual(ee.state, 'OUT');
    assert.strictEqual(ee.carStarted('demo', true), true);
    await wait(3800);                                                    // (0.75 -> 0.2: the demo seat's 0.22 / s)
    assert.strictEqual(ee.state, 'IDLE');
    at = b.status().seats.driver.pos;
    assert.ok(Math.abs(at.fore - 0.2) < 1e-9 && Math.abs(at.height - 0.7) < 1e-9, 'at position 1, not where it was at the stop');
    assert.ok(new S.Positions(dir, quiet).get('driver', 'mem1'), 'position 1 kept across a restart');
    // no position to save (a real seat not read yet): nothing saved, and it says so
    const blind = new S.EasyEntry({ status: () => ({ seats: { driver: { pos: { fore: null, height: null, back: null } } } }),
        refresh: () => Promise.resolve() }, new S.Positions(fs.mkdtempSync(path.join(os.tmpdir(), 'bre-seats-')), quiet), quiet);
    assert.strictEqual(await blind.savePosition(), false);
    assert.strictEqual(blind.events[0].key, 'ee.noPosition');
    assert.strictEqual(blind.hasPosition(), false);
    ok('position 1: saved, and where the seat comes back to when the car starts');

    // 9. OUT kept from before (the app restarted): Try: get in / the car started still bring the seat back
    //    (0.4.0 on the car: Try: get in did nothing after a restart - it waited for a door / ignition change)
    await b.goTo('driver', { fore: 0.3, height: 0.6, back: 0.3 });
    const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), 'bre-seats-'));
    let ee9 = new S.EasyEntry(b, new S.Positions(dir9, quiet), quiet);
    assert.strictEqual(ee9.carStopped('demo', true), true);
    await wait(3000);
    assert.strictEqual(ee9.state, 'OUT');
    ee9 = new S.EasyEntry(b, new S.Positions(dir9, quiet), quiet);          // a restart
    assert.strictEqual(ee9.state, 'OUT');
    assert.strictEqual(ee9.carStarted('demo', true), true, 'started (or Try: get in) after a restart: back in');
    await wait(3000);
    assert.strictEqual(ee9.state, 'IDLE');
    ok('OUT kept over a restart is brought back by a start or Try');

    // 10. not parked: nothing moves, and it says so
    const ee10 = new S.EasyEntry(b, new S.Positions(fs.mkdtempSync(path.join(os.tmpdir(), 'bre-seats-')), quiet), quiet);
    assert.strictEqual(ee10.carStopped('demo', false), false);
    assert.strictEqual(ee10.events[0].key, 'ee.notParked');
    ok('not parked: says so');

    // 11. the demo and the real seat keep their positions apart: the demo's OUT never moves the real seat
    const dir11 = fs.mkdtempSync(path.join(os.tmpdir(), 'bre-seats-'));
    let mode = 'demo';
    const moved = [];
    const real = { mode: 'armed', status: () => ({ seats: { driver: { pos: { fore: 0.2, height: 0.7, back: null } } } }),
        goTo: (s, t) => { moved.push(t); return Promise.resolve(true); }, stop() {} };
    const both = { get mode() { return mode === 'armed' ? 'armed' : 'demo'; },
        status() { return (mode === 'armed' ? real : b).status(); }, goTo(s, t) { return (mode === 'armed' ? real : b).goTo(s, t); },
        stop(s) { b.stop(s); } };
    const ee11 = new S.EasyEntry(both, new S.Positions(dir11, quiet), quiet);
    assert.strictEqual(ee11.carStopped('demo', true), true);
    await wait(3000);
    assert.strictEqual(ee11.state, 'OUT');
    assert.strictEqual(ee11.hasPosition(), false);
    mode = 'armed';                                                          // armed afterwards
    assert.strictEqual(ee11.carStarted('armed', true), false, 'the demo let it out: the real seat stays');
    assert.strictEqual(ee11.events[0].key, 'ee.otherMode');
    assert.deepStrictEqual(moved, [], 'the real seat was never moved');
    const kept = new S.Positions(dir11, quiet);
    assert.ok(kept.get('driver', 'drive') && !kept.get('driver.real', 'drive'), 'the demo\'s driving position is the demo\'s only');
    ok('the demo\'s positions and OUT never move the real seat');

    b.close();
    console.log(passed + ' passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
