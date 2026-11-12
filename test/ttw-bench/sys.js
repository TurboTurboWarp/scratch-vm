/**
 * @fileoverview System benchmarks (spec 08 §2): broadcast-and-wait with NPROC procedures in the receiver's
 * call closure, and many clones running a forever loop. Adapted from docs/TurboTurboWarp/bench/sys-tw.js.
 */
const VM = require('../../src/virtual-machine');
const {Proj, H} = require('./sb');

const {eq, get, set, chg, repeat, call, gt} = H;
const costume = {assetId: 'cd21514d0531fdffb22204e0ec5ed84a', name: 'c1', md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg', dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0};
const twoTargets = (stage, sprite) => {
    const j = JSON.parse(stage.json());
    const s = JSON.parse(sprite.json()).targets[0];
    Object.assign(s, {isStage: false, name: 'S', visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around', layerOrder: 1, costumes: [costume]});
    j.targets.push(s);
    return JSON.stringify(j);
};
// Milliseconds clock; the browser runner passes performance.now.
let clock = () => Number(process.hrtime.bigint()) / 1e6;
const time = fn => {
    const t0 = clock();
    fn();
    return clock() - t0;
};

const bcastProject = NPROC => {
    const p = new Proj();
    const c = p.v('c');
    const z = p.v('z');
    for (let k = NPROC; k >= 1; k--) p.declare(`p${k}`, [], true);
    for (let k = NPROC; k >= 1; k--) p.define(`p${k}`, [], true, [chg(c, 1), ...(k < NPROC ? [H.if(eq(get(z), 1), [call(p, `p${k + 1}`, [])])] : [])]);
    const bid = 'bc_tick';
    const menu = {op: 'event_broadcast_menu', f: {BROADCAST_OPTION: ['tick', bid]}};
    p.define('run', [], false, [set(c, 0), repeat(20000, [{op: 'event_broadcastandwait', in: {BROADCAST_INPUT: menu}}])]);
    p.flag([call(p, 'run', [])]);
    const hid = 'recv_hat';
    p.blocks[hid] = {opcode: 'event_whenbroadcastreceived', next: null, parent: null, inputs: {}, fields: {BROADCAST_OPTION: ['tick', bid]}, shadow: false, topLevel: true, x: 0, y: 9000};
    p.blocks[hid].next = p.stack([call(p, 'p1', [])], hid);
    const j = JSON.parse(p.json());
    j.targets[0].broadcasts[bid] = 'tick';
    return JSON.stringify(j);
};

const runBcast = async (NPROC, backend) => {
    const vm = new VM();
    vm.setCompilerOptions({warpTimer: false, backend});
    vm.setTurboMode(true);
    await vm.loadProject(bcastProject(NPROC));
    const ts = [];
    for (let r = 0; r < 5; r++) {
        ts.push(time(() => {
            vm.greenFlag();
            while (vm.runtime.threads.length > 0) vm.runtime._step();
        }));
    }
    const cv = Object.values(vm.runtime.getTargetForStage().variables).find(v => v.name === 'c').value;
    return {us: Math.min(...ts) / 20000 * 1000, c: cv};
};

const clonesProject = N => {
    const st = new Proj();
    // Counts the sequencer's passes over the thread list (every thread is stepped once per pass), so the
    // benchmark can count thread steps without hooking the sequencer.
    st.flag([{op: 'control_forever', sub: {SUBSTACK: [chg(st.v('passes'), 1)]}}]);
    const sp = new Proj();
    sp.flag([repeat(N, [{op: 'control_create_clone_of', in: {CLONE_OPTION: {op: 'control_create_clone_of_menu', f: {CLONE_OPTION: ['_myself_', null]}}}}])]);
    const hid = 'clone_hat';
    sp.blocks[hid] = {opcode: 'control_start_as_clone', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 9000};
    sp.blocks[hid].next = sp.stack([{op: 'control_forever', sub: {SUBSTACK: [{op: 'motion_changexby', in: {DX: 1}}, H.if(gt({op: 'motion_xposition'}, 200), [{op: 'motion_setx', in: {X: -200}}])]}}], hid);
    return twoTargets(st, sp);
};

const runClones = async (N, backend) => {
    const vm = new VM();
    vm.setCompilerOptions({warpTimer: false, backend});
    await vm.loadProject(clonesProject(N));
    vm.greenFlag();
    for (let i = 0; i < 50; i++) vm.runtime._step();
    let best = Infinity;
    let xs = null;
    const passes = Object.values(vm.runtime.getTargetForStage().variables).find(v => v.name === 'passes');
    for (let r = 0; r < 5; r++) {
        // Every thread runs a forever loop, so each pass steps each thread exactly once.
        const threadCount = vm.runtime.threads.length;
        const before = passes.value;
        const t = time(() => {
            for (let i = 0; i < 40; i++) vm.runtime._step();
        });
        const n = (passes.value - before) * threadCount;
        if (vm.runtime.threads.length !== threadCount) throw new Error('thread count changed');
        best = Math.min(best, t / n * 1e6);
        xs = vm.runtime.targets.filter(t2 => !t2.isOriginal).length;
    }
    return {ns: best, clones: xs};
};

const run = async (filter, clockFn) => {
    if (clockFn) clock = clockFn;
    const results = [];
    const want = name => !filter.length || filter.includes(name);
    for (const NPROC of [1, 20, 100]) {
        const name = `bcast${NPROC}`;
        if (!want(name)) continue;
        const tw = await runBcast(NPROC, 'tw');
        const ttw = await runBcast(NPROC, 'ttw');
        results.push({name, tw: tw.us, ttw: ttw.us, match: tw.c === ttw.c, unit: 'us/broadcast'});
    }
    if (want('clones')) {
        const tw = await runClones(300, 'tw');
        const ttw = await runClones(300, 'ttw');
        results.push({name: 'clones', tw: tw.ns, ttw: ttw.ns, match: tw.clones === ttw.clones, unit: 'ns/thread-step'});
    }
    return results;
};

module.exports = {run, bcastProject, clonesProject};
