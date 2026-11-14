'use strict';
/**
 * Tests for apps/bre_hub/exhaust.js and dme_link.js against a fake engine controller: what is sent, when, and
 * above all what is NOT sent. No car, no kit: node tests/test_exhaust.js (Node 8 or newer).
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

// dme_link.js requires ./kit/diag: a stand-in whose transport records what would leave the head unit
const wire = [];
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
class FakeDiag {
    constructor() { this.available = true; }
    async init() { return this; }
    on() {}
    async physical(target, sid, data) {
        wire.push(hex(sid) + ' ' + data.map(hex).join(' ') + ' -> ' + hex(target));
        if (sid === 0x22) return [0x62, data[0], data[1], 0x03, 0xE8];
        return [sid + 0x40].concat(data);
    }
}
const stub = { Diag: FakeDiag, hex: hex, NRC: {}, replyTo: () => () => true };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request) {
    if (request === './kit/diag') return 'kit-stub:diag';
    return origResolve.apply(this, arguments);
};
require.cache['kit-stub:diag'] = { id: 'kit-stub:diag', filename: 'diag', loaded: true, exports: stub };

const app = path.join(__dirname, '..', 'apps', 'bre_hub');
const { Exhaust, modeGroup } = require(path.join(app, 'exhaust'));
const { DmeLink, FLAP, READS } = require(path.join(app, 'dme_link'));

const quiet = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** An Exhaust on a fake link. set: settings; o: { flap: the DME has one (default true), up: link available } */
function rig(set, o) {
    const opt = o || {};
    const values = Object.assign({ exhaustArm: 'on', exhaustHold: 'off', exhaustCloseLimit: '4000', exhaustDrive: 'off',
        exhaustSport: 'open', exhaustComfort: 'oem', exhaustEco: 'closed' }, set || {});
    const sent = [], eng = { rpm: 900 };
    const link = {
        available: opt.up !== false,
        async readFlap() { const last = sent[sent.length - 1]; return { supported: opt.flap !== false, commandedPct: last === 'OPEN' ? 10 : last === 'CLOSED' ? 90 : null }; },
        async flap(mode) { await wait(5); sent.push(mode); return { ok: true }; },
    };
    const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; } };
    const ex = new Exhaust({ link: link, settings: settings, rpm: () => eng.rpm, log: quiet, holdMs: 60 });
    return { ex, sent, eng, values, link };
}

async function run() {
    let passed = 0;
    const ok = (name) => { passed++; console.log('ok - ' + name); };

    // 1. disarmed: simulated, nothing is asked of the car and nothing is sent
    let r = rig({ exhaustArm: 'off' });
    let asked = 0;
    r.link.readFlap = async () => { asked++; return { supported: true, commandedPct: null }; };
    await r.ex.refresh();
    await r.ex.press('OPEN');
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(asked, 0, 'no read while disarmed');
    assert.strictEqual(r.ex.view().selected, 'OPEN');
    assert.strictEqual(r.ex.view().note.key, 'ex.simulated');
    await wait(150);
    assert.deepStrictEqual(r.sent, [], 'no repeats while disarmed');
    ok('disarmed sends nothing');

    // 2. armed, but this DME has no flap: never written to
    r = rig({}, { flap: false });
    await r.ex.refresh();
    await r.ex.press('OPEN');
    await r.ex.press('CLOSED');
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(r.ex.view().note.key, 'ex.noFlap');
    ok('a DME without the flap is never written to');

    // 3. armed, no diagnostic link: nothing sent, and it says so
    r = rig({}, { up: false });
    await r.ex.refresh();
    await r.ex.press('OPEN');
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(r.ex.view().note.key, 'ex.noLink');
    ok('no link: nothing sent');

    // 4. armed with the flap: Open goes once, is read back, Auto hands it back
    r = rig();
    await r.ex.refresh();
    await r.ex.press('OPEN');
    assert.deepStrictEqual(r.sent, ['OPEN']);
    assert.strictEqual(r.ex.view().confirmed, 'OPEN');
    await wait(150);
    assert.deepStrictEqual(r.sent, ['OPEN'], 'hold off: no repeats');
    await r.ex.press('OEM');
    assert.deepStrictEqual(r.sent, ['OPEN', 'OEM']);
    ok('Open, then Auto');

    // 5. hold: Open is sent again every holdMs, and stops with Auto
    r = rig({ exhaustHold: 'on' });
    await r.ex.refresh();
    await r.ex.press('OPEN');
    await wait(220);
    const repeats = r.sent.length;
    assert.ok(repeats >= 3 && r.sent.every((m) => m === 'OPEN'), 'repeated: ' + r.sent.join(','));
    assert.strictEqual(r.ex.view().note.key, 'ex.holding');
    await r.ex.press('OEM');
    const after = r.sent.length;
    await wait(200);
    assert.strictEqual(r.sent.length, after, 'no repeats after Auto');
    assert.strictEqual(r.sent[after - 1], 'OEM');
    ok('hold repeats Open and stops with Auto');

    // 6. Auto is never dropped: pressed while Open is on its way, it goes right after; pressed in the same
    //    instant, Open never leaves
    r = rig();
    await r.ex.refresh();
    const p1 = r.ex.press('OPEN');
    await wait(2);
    const p2 = r.ex.press('OEM');
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(r.sent, ['OPEN', 'OEM']);
    r = rig();
    await r.ex.refresh();
    await Promise.all([r.ex.press('OPEN'), r.ex.press('OEM')]);
    assert.ok(r.sent.length && r.sent.every((m) => m === 'OEM'), 'only the hand-back: ' + r.sent.join(','));
    ok('Auto after Open always ends with the hand-back');

    // 7. Closed: handed back above the limit, resumed 500 rpm below it
    r = rig();
    await r.ex.refresh();
    r.eng.rpm = 5000;
    await r.ex.press('CLOSED');
    assert.deepStrictEqual(r.sent, ['OEM'], 'over the limit: the car keeps the flap');
    assert.strictEqual(r.ex.view().note.key, 'ex.pausedRpm');
    r.eng.rpm = 3800; await r.ex.tick();
    assert.deepStrictEqual(r.sent, ['OEM'], 'inside the hysteresis: still paused');
    r.eng.rpm = 3000; await r.ex.tick();
    assert.deepStrictEqual(r.sent, ['OEM', 'CLOSED']);
    r.eng.rpm = 4500; await r.ex.tick();
    assert.deepStrictEqual(r.sent, ['OEM', 'CLOSED', 'OEM']);
    ok('Closed is handed back above the limit');

    // 8. Closed without a live engine speed: Auto, until Closed is pressed again
    r = rig();
    await r.ex.refresh();
    r.eng.rpm = null;
    await r.ex.press('CLOSED');
    assert.deepStrictEqual(r.sent, ['OEM']);
    assert.strictEqual(r.ex.view().note.key, 'ex.rpmLost');
    r.eng.rpm = 900; await r.ex.tick();
    assert.deepStrictEqual(r.sent, ['OEM'], 'not resumed by itself');
    await r.ex.press('CLOSED');
    assert.deepStrictEqual(r.sent, ['OEM', 'CLOSED']);
    r.eng.rpm = null; await r.ex.tick();
    assert.deepStrictEqual(r.sent, ['OEM', 'CLOSED', 'OEM'], 'the engine speed went: handed back');
    ok('Closed needs a live engine speed');

    // 9. by driving mode, with the flap of each group as set
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 61].map(modeGroup),
        ['sport', 'sport', 'sport', 'comfort', 'comfort', 'comfort', 'eco', 'eco', 'eco', 'comfort', null, null]);
    assert.deepStrictEqual([15, 23, 28, 17, 19, 18, 20, 22].map(modeGroup), ['sport', 'sport', 'sport', 'comfort', 'comfort', 'eco', 'eco', null]);
    assert.deepStrictEqual(['SPORT_DYNAMIC', 'ECO_PRO_EFFICIENT', 'COMFORT', 'PHEV_ELECTRIC_STANDARD'].map(modeGroup), ['sport', 'eco', 'comfort', 'eco']);
    r = rig();
    await r.ex.refresh();
    await r.ex.driveMode(1);
    assert.deepStrictEqual(r.sent, [], 'not followed: the driving mode is ignored');
    await r.ex.press('DRIVE');
    assert.strictEqual(r.values.exhaustDrive, 'on');
    assert.deepStrictEqual(r.sent, ['OPEN'], 'Sport -> Open');
    await r.ex.driveMode(1);
    assert.deepStrictEqual(r.sent, ['OPEN'], 'the same mode again sends nothing');
    await r.ex.driveMode(4); await r.ex.driveMode(7);
    assert.deepStrictEqual(r.sent, ['OPEN', 'OEM', 'CLOSED']);
    r.values.exhaustEco = 'open';                       // custom: Eco Pro -> Open
    await r.ex.settingsChanged('exhaustEco');
    assert.deepStrictEqual(r.sent, ['OPEN', 'OEM', 'CLOSED', 'OPEN']);
    r.values.exhaustSport = 'closed';                   // custom: Sport -> Closed
    await r.ex.driveMode(2);
    assert.strictEqual(r.sent[r.sent.length - 1], 'CLOSED');
    await r.ex.press('OEM');                            // a manual choice stops following
    assert.strictEqual(r.values.exhaustDrive, 'off');
    await r.ex.driveMode(1);
    assert.strictEqual(r.sent[r.sent.length - 1], 'OEM');
    ok('follows the driving mode, each group to the flap set for it');

    // 10. arming never sends a choice made while simulated
    r = rig({ exhaustArm: 'off', exhaustHold: 'on' });
    await r.ex.press('OPEN');
    r.values.exhaustArm = 'on';
    await r.ex.refresh();
    await r.ex.settingsChanged('exhaustArm');
    await wait(150);
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(r.ex.view().selected, 'OEM');
    await r.ex.press('OPEN');
    assert.strictEqual(r.sent[0], 'OPEN');
    r.values.exhaustArm = 'off';                        // disarmed again: the repeats stop
    await r.ex.refresh();
    await r.ex.settingsChanged('exhaustArm');
    const n = r.sent.length;
    await wait(200);
    assert.strictEqual(r.sent.length, n, 'no repeats after disarming');
    r.ex.close();
    ok('arming sends nothing by itself; disarming stops the repeats');

    // 11. dme_link.js: only the three flap requests can be written, only three identifiers read
    assert.deepStrictEqual([FLAP.OPEN, FLAP.CLOSED, FLAP.OEM].map((b) => b.map(hex).join('')), ['60FD0303E8', '60FD032328', '60FD00']);
    assert.ok(Object.isFrozen(FLAP) && Object.isFrozen(FLAP.OPEN));
    const link = await new DmeLink({}, quiet).init();
    wire.length = 0;
    assert.deepStrictEqual(await link.flap('OPEN'), { ok: true });
    await link.flap('CLOSED'); await link.flap('OEM');
    assert.deepStrictEqual(wire, ['2F 60 FD 03 03 E8 -> 12', '2F 60 FD 03 23 28 -> 12', '2F 60 FD 00 -> 12']);
    let threw = 0;
    for (const bad of ['open', 'toString', '__proto__', [0x60, 0xFD, 0x03, 0x00, 0x00], undefined]) {
        try { await link.flap(bad); } catch (e) { threw++; }
    }
    assert.strictEqual(threw, 5, 'anything but OPEN / CLOSED / OEM is refused');
    assert.strictEqual(wire.length, 3, 'and nothing left for them');
    wire.length = 0;
    assert.strictEqual((await link.readDid([0xF1, 0x8C])).ok, false, 'an identifier BRE Hub does not read');
    assert.strictEqual((await link.readDid([0x60, 0xFD])).ok, false);
    assert.strictEqual(wire.length, 0);
    assert.strictEqual(READS.length, 3);
    assert.strictEqual((await link.readFlap()).commandedPct, 10);
    assert.deepStrictEqual(wire, ['22 62 FD -> 12', '22 64 FD -> 12']);
    link.available = false;
    wire.length = 0;
    assert.strictEqual((await link.flap('OPEN')).ok, false);
    assert.strictEqual(wire.length, 0, 'no link: nothing leaves');
    ok('the link writes only the three flap requests');

    console.log(passed + ' passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
