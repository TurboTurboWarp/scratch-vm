'use strict';
// Loop versioning experiment: fast loop has NO calls and NO never-executed feedback sites; cold conditions exit via break (bail) to the generic loop.
const {TList, toNum, gtSlow, modSlow, Variable} = require('./rt');
const T = (name, fn, reps = 15) => { const ts = []; let r; for (let i = 0; i < reps; i++) { const t0 = process.hrtime.bigint(); r = fn(); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); } ts.sort((a, b) => a - b); console.log(name.padEnd(46), 'min', ts[0].toFixed(2).padStart(7), 'med', ts[ts.length >> 1].toFixed(2).padStart(7), r); };
const A = new TList();
const fill = () => { A.clear(); let seed = 12345; for (let a0 = 3000; a0 > 0; a0--) { seed = (seed * 1103515245 + 12345) % 2147483648; A.pushSlow(seed % 100000); } };
const sortVersioned = () => { let i, j, t, x, u, bail;
  fill(); i = 2;
  for (let a1 = A.len - 1; a1 > 0; a1--) {
    t = (i >= 1 && i <= A.len && (x = A.f64[(i | 0) - 1], x === x)) ? x : A.getSlow(i);
    j = i - 1;
    // ---- loop pre-header: hoisted invariants (A numeric-only, t is a non-NaN number) ----
    bail = true;
    if (A.objs.length === 0 && typeof t === 'number' && t === t) {
      const f = A.f64, n = A.len, tn = +t; bail = false;
      while (true) {                                   // FAST VERSION: no calls, bail only before side effects of the iteration
        if (j < 1) break;
        if (!(j <= n)) { bail = true; break; }          // OOB read would yield "" -> generic semantics
        x = f[(j | 0) - 1];
        if (x !== x) { bail = true; break; }            // NaN element -> generic compare
        if (!(x > tn)) break;
        u = j + 1; if (u <= n) f[(u | 0) - 1] = x;
        j = j + -1; }
    }
    if (bail) {                                         // GENERIC VERSION (continues from current j)
      while (!(j < 1 || !(((x = (j >= 1 && j <= A.len && (u = A.f64[(j | 0) - 1], u === u)) ? u : A.getSlow(j)), typeof x === 'number' && typeof t === 'number' && x === x && t === t) ? x > t : gtSlow(x, t)))) {
        x = (j >= 1 && j <= A.len && (u = A.f64[(j | 0) - 1], u === u)) ? u : A.getSlow(j); A.setSlow(j + 1, x); j = j + -1; } }
    u = j + 1; if (typeof t === 'number' && u >= 1 && u <= A.len && A.objs.length === 0) A.f64[(u | 0) - 1] = t; else A.setSlow(u, t);
    i = i + 1; }
  return A.numSlow(1) + A.numSlow(1500) + A.numSlow(3000); };
T('sort versioned (fast loop + generic twin)', sortVersioned);
// strlist / sum loop versioned: numeric ctx read => cold value is the constant 0 when list is numeric-only
const init = []; for (let k = 0; k < 100000; k++) init.push((k * 7919) % 1000);
const D = TList.from(init);
T('strlist versioned', () => { let sum = 0, i = 0, x = 0;
  for (let a0 = 20; a0 > 0; a0--) { i = 1;
    if (D.objs.length === 0) { for (let a1 = D.len; a1 > 0; a1--) { sum = sum + ((i >= 1 && i <= D.len && (x = D.f64[(i | 0) - 1], x === x)) ? x : 0); i = i + 1; } }
    else { for (let a1 = D.len; a1 > 0; a1--) { sum = sum + ((i >= 1 && i <= D.len && (x = D.f64[(i | 0) - 1], x === x)) ? x : D.numSlow(i)); i = i + 1; } } }
  return sum; });
// grid-like mixed list: reads of '' are common => generic path is HOT. any-context read is call-free with the side table.
const G = new TList();
T('grid call-free mixed reads', () => { let i, sum, x, o, q, r, k;
  G.clear(); for (let a0 = 100000; a0 > 0; a0--) G.pushSlow('');
  for (let a1 = 20; a1 > 0; a1--) { i = 1;
    for (let a2 = G.len; a2 > 0; a2--) {
      if (i >= 1 && i <= G.len) { k = (i | 0) - 1; x = G.f64[k];
        if (x === x) { G.f64[k] = x + 1.5; }                                   // number: item = "" is false => else-branch: replace with item + 1.5 (store keeps objs[k] undefined)
        else { o = G.objs[k];                                                  // non-number (or real NaN)
          if (o === '') { if (i % 3 === 0) { G.f64[k] = i * 0.5; G.objs[k] = undefined; } }
          else { /* generic */ const v = o === undefined ? NaN : o; G.setSlow(i, toNum(v) + 1.5); } } }
      else { /* OOB: "" = "" true */ }
      i = i + 1; } }
  sum = 0; i = 1; for (let a3 = G.len; a3 > 0; a3--) { sum = sum + ((i >= 1 && i <= G.len && (x = G.f64[(i | 0) - 1], x === x)) ? x : G.numSlow(i)); i = i + 1; }
  return sum; });
