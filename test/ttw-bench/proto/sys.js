'use strict';
// Prototype of the TTW thread model: resumable step functions + frame records + broadcast table (no generators, no per-thread closures).
const RUNNING = 0, DONE = 4;
const YIELD = 0, SWITCH = 1, FINISHED = 2;
class Thread { constructor () { this.status = RUNNING; this.fn = null; this.frame = null; this.target = null; this.script = null; this.ret = ''; this.slot = -1; } }
class Target { constructor (nScripts) { this.x = 0; this.y = 0; this.live = new Array(nScripts).fill(null); } setXY (x, y) { this.x = x; this.y = y; } }
const pool = [];
const threads = [];
const startScript = (target, script) => {           // restartExistingThreads semantics via per-target slot (no string keys, no scans)
  const old = target.live[script.index];
  const th = pool.length ? pool.pop() : new Thread();
  th.status = RUNNING; th.target = target; th.script = script; th.fn = script.fn; th.frame = script.newFrame();
  if (old !== null && old.status !== DONE) { old.status = DONE; threads[old.slot] = th; th.slot = old.slot; } else { th.slot = threads.length; threads.push(th); }
  target.live[script.index] = th; return th; };
const stepAll = () => { let active = 0, stopped = false;
  for (let i = 0; i < threads.length; i++) { const th = threads[i]; if (th.status !== RUNNING) { stopped = true; continue; }
    let r; do { r = th.fn(th, th.frame); } while (r === SWITCH);
    if (r === FINISHED) { th.status = DONE; stopped = true; } else active++; }
  if (stopped) { let n = 0; for (let i = 0; i < threads.length; i++) { const th = threads[i]; if (th.status !== DONE) { th.slot = n; threads[n++] = th; } else { if (th.target.live[th.script.index] === th) th.target.live[th.script.index] = null; pool.push(th); } } threads.length = n; }
  return active; };
// ---------------- bcast benchmark: sender does 20000 x "broadcast and wait tick"; receiver: call p1 (c += 1)
const stage = new Target(2); const g = {c: {value: 0}, z: {value: 0}};
class F0 { constructor () { this.pc = 0; this.s0 = 0; this.w = null; } }
const receivers = [];                                   // broadcast table for "TICK": [(target, script)]
const recvScript = {index: 1, newFrame: () => null, fn: (th, fr) => { g.c.value = g.c.value + 1; return FINISHED; }};
receivers.push(stage, recvScript);
const sendScript = {index: 0, newFrame: () => new F0(), fn: (th, fr) => {
  for (;;) switch (fr.pc) {
  case 0: g.c.value = 0; fr.s0 = 20000;
  case 1: if (!(fr.s0 > 0)) { fr.pc = 4; continue; }
    { const w = []; for (let k = 0; k < receivers.length; k += 2) w.push(startScript(receivers[k], receivers[k + 1])); fr.w = w; }
    fr.pc = 2; return YIELD;                              // broadcast-and-wait always yields at least... (poll)
  case 2: { const w = fr.w; for (let k = 0; k < w.length; k++) if (w[k].status !== DONE) return YIELD; }
    fr.s0--; fr.pc = 1; return YIELD;                     // non-warp loop yield
  case 4: return FINISHED; } }};
const T = (name, fn, reps = 7) => { const ts = []; let r; for (let i = 0; i < reps; i++) { const t0 = process.hrtime.bigint(); r = fn(); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); } ts.sort((a, b) => a - b); return ts[0]; };
const t = T('bcast', () => { startScript(stage, sendScript); while (threads.length > 0) stepAll(); return g.c.value; });
console.log('bcast: 20000 broadcast-and-wait:', t.toFixed(2), 'ms =>', (t / 20000 * 1e6).toFixed(0), 'ns/broadcast  (c =', g.c.value + ')');
// ---------------- clones benchmark: 300 clone threads, forever { change x by 1; if x > 200 set x to -200 }
threads.length = 0;
const cloneScript = {index: 0, newFrame: () => null, fn: (th, fr) => { const target = th.target; target.setXY(target.x + 1, target.y); const v = target.x; const r = Math.round(v); if ((Math.abs(v - r) < 1e-9 ? r : v) > 200) target.setXY(-200, target.y); return YIELD; }};
for (let i = 0; i < 300; i++) startScript(new Target(1), cloneScript);
for (let r = 0; r < 2000; r++) stepAll();
const t0 = process.hrtime.bigint(); const R = 20000; for (let r = 0; r < R; r++) stepAll(); const dt = Number(process.hrtime.bigint() - t0);
console.log('clones: ', (dt / (R * 300)).toFixed(1), 'ns/thread-step (incl. scheduler loop)');
