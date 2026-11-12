const path = require('path');
const VMDIR = '/home/claude/src/scratch-vm';
const VM = require(path.join(VMDIR, 'src/virtual-machine'));
const {Proj, H} = require('./sb');
const {add, sub, mul, lt, gt, eq, get, set, chg, repeat, call} = H;
const costume = {assetId: 'cd21514d0531fdffb22204e0ec5ed84a', name: 'c1', md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg', dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0};
const twoTargets = (stage, sprite) => { const j = JSON.parse(stage.json()); const s = JSON.parse(sprite.json()).targets[0];
  Object.assign(s, {isStage: false, name: 'S', visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around', layerOrder: 1, costumes: [costume]});
  j.targets.push(s); return JSON.stringify(j); };
const time = fn => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
(async () => {
  // --- bcast: broadcast-and-wait in a loop; receiver's dependency closure has NPROC procedures
  for (const NPROC of [1, 20, 100]) {
    const p = new Proj(); const [c, z] = ['c', 'z'].map(v => p.v(v));
    for (let k = NPROC; k >= 1; k--) p.declare(`p${k}`, [], true);
    for (let k = NPROC; k >= 1; k--) p.define(`p${k}`, [], true, [chg(c, 1), ...(k < NPROC ? [H.if(eq(get(z), 1), [call(p, `p${k + 1}`, [])])] : [])]);
    const bid = 'bc_tick';
    const menu = {op: 'event_broadcast_menu', f: {BROADCAST_OPTION: ['tick', bid]}};
    p.define('run', [], false, [set(c, 0), repeat(20000, [{op: 'event_broadcastandwait', in: {BROADCAST_INPUT: menu}}])]);
    p.flag([call(p, 'run', [])]);
    // receiver hat
    const hid = 'recv_hat'; p.blocks[hid] = {opcode: 'event_whenbroadcastreceived', next: null, parent: null, inputs: {}, fields: {BROADCAST_OPTION: ['tick', bid]}, shadow: false, topLevel: true, x: 0, y: 9000};
    p.blocks[hid].next = p.stack([call(p, 'p1', [])], hid);
    const j = JSON.parse(p.json()); j.targets[0].broadcasts[bid] = 'tick';
    const vm = new VM(); vm.setCompilerOptions({warpTimer: false}); vm.setTurboMode(true); await vm.loadProject(JSON.stringify(j));
    const ts = []; let steps = 0;
    for (let r = 0; r < 5; r++) { ts.push(time(() => { vm.greenFlag(); steps = 0; while (vm.runtime.threads.length > 0) { vm.runtime._step(); steps++; } })); }
    const cv = Object.values(vm.runtime.getTargetForStage().variables).find(v => v.name === 'c').value;
    console.log(`bcast NPROC=${NPROC}`.padEnd(18), 'min', Math.min(...ts).toFixed(1), 'ms for 20000 broadcasts; steps', steps, 'c =', cv, ' => ', (Math.min(...ts) / 20000 * 1000).toFixed(2), 'us/broadcast');
  }
  // --- clones: N clones each running a forever loop; cost per frame
  for (const N of [300]) {
    const st = new Proj(); st.flag([]);
    const sp = new Proj(); const hv = sp.v('h');
    sp.flag([repeat(N, [{op: 'control_create_clone_of', in: {CLONE_OPTION: {op: 'control_create_clone_of_menu', f: {CLONE_OPTION: ['_myself_', null]}}}}])]);
    const hid = 'clone_hat'; sp.blocks[hid] = {opcode: 'control_start_as_clone', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 9000};
    sp.blocks[hid].next = sp.stack([{op: 'control_forever', sub: {SUBSTACK: [{op: 'motion_changexby', in: {DX: 1}}, H.if(gt({op: 'motion_xposition'}, 200), [{op: 'motion_setx', in: {X: -200}}])]}}], hid);
    const vm = new VM(); vm.setCompilerOptions({warpTimer: false}); await vm.loadProject(twoTargets(st, sp));
    vm.greenFlag(); for (let i = 0; i < 50; i++) vm.runtime._step();
    const nthreads = vm.runtime.threads.length;
    let n = 0; const seq = vm.runtime.sequencer; const orig = seq.stepThread.bind(seq); seq.stepThread = th => { n++; return orig(th); };
    const FR = 40; const t = time(() => { for (let i = 0; i < FR; i++) vm.runtime._step(); });
    console.log(`clones N=${N}`.padEnd(18), 'threads', nthreads, 'thread-steps', n, (t / n * 1e6).toFixed(0), 'ns/thread-step (incl. sequencer loop)');
  }
  process.exit(0);
})();
