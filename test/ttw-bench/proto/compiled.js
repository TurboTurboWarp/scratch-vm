// Hand-compiled output for the benchmark programs, following the TurboTurboWarp codegen rules:
//  * one module per project; procedures are plain functions called directly
//  * variables promoted to JS locals inside native functions, entry type guards (program-NUM vars), flush on exit
//  * lists are TList (Float64Array + side table), inline guarded fast paths, slow paths out of line
//  * exact Scratch/TW semantics on every slow path
'use strict';
const {TList, toNum, eqSlow, gtSlow, ltSlow, modSlow, Variable} = require('./rt');
const bench = (name, fn, reps = 9) => { const ts = []; let r; for (let i = 0; i < reps; i++) { const t0 = process.hrtime.bigint(); r = fn(); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); } ts.sort((a, b) => a - b); return {name, min: +ts[0].toFixed(2), med: +ts[ts.length >> 1].toFixed(2), result: r}; };
const V = n => new Variable(n, 0);
const out = [];

// ===== mandel =====
{ const g = {sum: V('sum'), py: V('py'), px: V('px'), x0: V('x0'), y0: V('y0'), x: V('x'), y: V('y'), i: V('i'), xt: V('xt')};
  const run = () => { // all 9 vars: written before read => no entry guards needed
    let sum, py, px, x0, y0, x, y, i, xt;
    sum = 0; py = 0;
    for (let a0 = 300; a0 > 0; a0--) { px = 0;
      for (let a1 = 300; a1 > 0; a1--) { x0 = px / 300 * 3.5 - 2.5; y0 = py / 300 * 2 - 1; x = 0; y = 0; i = 0;
        while (!(!(x * x + y * y <= 4) || !(i < 200))) { xt = x * x - y * y + x0; y = 2 * x * y + y0; x = xt; i = i + 1; }
        sum = sum + i; px = px + 1; }
      py = py + 1; }
    g.sum.value = sum; g.py.value = py; g.px.value = px; g.x0.value = x0; g.y0.value = y0; g.x.value = x; g.y.value = y; g.i.value = i; g.xt.value = xt; };
  out.push(bench('mandel', () => { run(); return g.sum.value; })); }

// ===== sieve =====
{ const g = {n: V('n'), i: V('i'), j: V('j'), count: V('count')}; const L = new TList();
  const run = () => { let n, i, j, count, x, k;
    n = 1000000; L.clear();
    for (let a0 = n; a0 > 0; a0--) { if (L.len >= 0 && L.len < L.f64.length && L.objs.length === 0) { L.f64[L.len++] = 1; } else L.pushSlow(1); }
    L.upToDate = false;
    i = 2;
    while (!(i * i > n)) {
      // item i of L = 1   (compare with numeric constant: number fast path, else exact slow path)
      if ((i >= 1 && i <= L.len && (x = L.f64[(i | 0) - 1], x === x)) ? x === 1 : eqSlow(L.getSlow(i), 1)) {
        j = i * i;
        while (!(j > n)) { if (j >= 1 && j <= L.len && L.objs.length === 0) L.f64[(j | 0) - 1] = 0; else L.setSlow(j, 0); j = j + i; }
        L.upToDate = false; }
      i = i + 1; }
    count = 0; i = 2;
    for (let a1 = n - 1; a1 > 0; a1--) { if ((i >= 1 && i <= L.len && (x = L.f64[(i | 0) - 1], x === x)) ? x === 1 : eqSlow(L.getSlow(i), 1)) count = count + 1; i = i + 1; }
    g.n.value = n; g.i.value = i; g.j.value = j; g.count.value = count; };
  out.push(bench('sieve', () => { run(); return g.count.value; })); }

// ===== fib (interprocedural: param n NUM from all call sites; return NUM|... n itself) =====
{ const g = {r: V('r')};
  const fib = p0 => { if (p0 < 2) return p0; return fib(p0 - 1) + fib(p0 - 2); };
  const run = () => { g.r.value = fib(30); };
  out.push(bench('fib', () => { run(); return g.r.value; })); }

// ===== calls (step inlined by our inliner; fast integer mod) =====
{ const g = {acc: V('acc'), i: V('i')};
  const run = () => { let acc, i, m, r; acc = 0; i = 0;
    for (let a0 = 3000000; a0 > 0; a0--) { const p0 = i, p1 = i + 1;
      m = p0 * p1; // mod(m, 7) with constant positive integer modulus: exact integer fast path
      if (m >= 0 && m <= 9007199254740991 && m === Math.floor(m)) { r = m - Math.floor(m / 7) * 7; if (r < 0) r += 7; else if (r >= 7) r -= 7; } else r = modSlow(m, 7);
      acc = acc + r; i = i + 1; }
    g.acc.value = acc; g.i.value = i; };
  out.push(bench('calls', () => { run(); return g.acc.value; })); }

// ===== sort =====
{ const g = {seed: V('seed'), i: V('i'), j: V('j'), t: V('t'), chk: V('chk')}; const A = new TList();
  const run = () => { let seed, i, j, t, chk, x, y, m, r, u;
    A.clear(); seed = 12345;
    for (let a0 = 3000; a0 > 0; a0--) {
      m = seed * 1103515245 + 12345; if (m >= 0 && m <= 9007199254740991 && m === Math.floor(m)) { r = m - Math.floor(m / 2147483648) * 2147483648; if (r < 0) r += 2147483648; else if (r >= 2147483648) r -= 2147483648; } else r = modSlow(m, 2147483648);
      seed = r;
      if (seed >= 0 && seed <= 9007199254740991 && seed === Math.floor(seed)) { r = seed - Math.floor(seed / 100000) * 100000; if (r < 0) r += 100000; else if (r >= 100000) r -= 100000; } else r = modSlow(seed, 100000);
      if (A.len >= 0 && A.len < A.f64.length && A.objs.length === 0) A.f64[A.len++] = r; else A.pushSlow(r); }
    i = 2;
    for (let a1 = A.len - 1; a1 > 0; a1--) {
      // t = item i of A  (any-context read: number fast path keeps t numeric; slow path is cold)
      t = (i >= 1 && i <= A.len && (x = A.f64[(i | 0) - 1], x === x)) ? x : A.getSlow(i);
      j = i - 1;
      while (!(j < 1 || !(((x = (j >= 1 && j <= A.len && (y = A.f64[(j | 0) - 1], y === y)) ? y : A.getSlow(j)), typeof x === 'number' && typeof t === 'number') ? x > t : gtSlow(x, t)))) {
        x = (j >= 1 && j <= A.len && (y = A.f64[(j | 0) - 1], y === y)) ? y : A.getSlow(j);
        u = j + 1; if (typeof x === 'number' && u >= 1 && u <= A.len && A.objs.length === 0) A.f64[(u | 0) - 1] = x; else A.setSlow(u, x);
        j = j + -1; }
      u = j + 1; if (typeof t === 'number' && u >= 1 && u <= A.len && A.objs.length === 0) A.f64[(u | 0) - 1] = t; else A.setSlow(u, t);
      i = i + 1; }
    A.upToDate = false;
    chk = ((A.len >= 1 && (x = A.f64[0], x === x)) ? x : A.numSlow(1)) + (((A.len >= 1500 && (x = A.f64[1499], x === x)) ? x : A.numSlow(1500)) + ((A.len >= 3000 && (x = A.f64[2999], x === x)) ? x : A.numSlow(3000)));
    g.seed.value = seed; g.i.value = i; g.j.value = j; g.t.value = t; g.chk.value = chk; };
  out.push(bench('sort', () => { run(); return g.chk.value; })); }

// ===== strlist (list normalised at load: canonical numeric strings -> numbers) =====
{ const g = {sum: V('sum'), i: V('i')}; const init = []; for (let k = 0; k < 100000; k++) init.push(String((k * 7919) % 1000));
  const D = TList.from(init.map(s => (String(+s) === s ? +s : s)));
  const run = () => { let sum, i, x; sum = 0;
    for (let a0 = 20; a0 > 0; a0--) { i = 1; for (let a1 = D.len; a1 > 0; a1--) { sum = sum + ((i >= 1 && i <= D.len && (x = D.f64[(i | 0) - 1], x === x)) ? x : D.numSlow(i)); i = i + 1; } }
    g.sum.value = sum; g.i.value = i; };
  out.push(bench('strlist', () => { run(); return g.sum.value; })); }

// ===== proj3d (rot NOT inlined here to show call + mod/ref flush cost; cx,sx,tx,ty,tz are program-NUM/ANY globals) =====
{ const g = {i: V('i'), cx: V('cx'), sx: V('sx'), tx: V('tx'), ty: V('ty'), tz: V('tz'), acc: V('acc'), f: V('f')};
  const X = new TList(), Y = new TList(), Z = new TList(), SX = new TList(), SY = new TList();
  const rot$g = (p0, p1, p2) => { throw new Error('generic twin compiled lazily'); };
  // rot: params p0,p2 inferred NUM|"" (list reads) => any-typed with inline numeric view; reads cx,sx (program-NUM: entry guard); writes tx,tz (NUM), ty (ANY)
  const rot = (p0, p1, p2) => { const cx = g.cx.value, sx = g.sx.value; if (typeof cx !== 'number' || typeof sx !== 'number') return rot$g(p0, p1, p2);
    const n0 = typeof p0 === 'number' ? (p0 === p0 ? p0 : 0) : toNum(p0), n2 = typeof p2 === 'number' ? (p2 === p2 ? p2 : 0) : toNum(p2);
    g.tx.value = n0 * cx - n2 * sx; g.tz.value = n0 * sx + n2 * cx; g.ty.value = p1; };
  const pushN = (L, v) => { if (L.len >= 0 && L.len < L.f64.length && L.objs.length === 0) L.f64[L.len++] = v; else L.pushSlow(v); };
  const run = () => { let i, acc, f, cx, sx, tx, ty, tz, x, q, d;
    X.clear(); Y.clear(); Z.clear(); SX.clear(); SY.clear(); i = 0;
    for (let a0 = 20000; a0 > 0; a0--) {
      q = i * 37; pushN(X, ((q >= 0 && q <= 9007199254740991 && q === Math.floor(q)) ? q - Math.floor(q / 200) * 200 : modSlow(q, 200)) - 100);
      q = i * 91; pushN(Y, ((q >= 0 && q <= 9007199254740991 && q === Math.floor(q)) ? q - Math.floor(q / 200) * 200 : modSlow(q, 200)) - 100);
      q = i * 53; pushN(Z, ((q >= 0 && q <= 9007199254740991 && q === Math.floor(q)) ? q - Math.floor(q / 200) * 200 : modSlow(q, 200)) - 100);
      pushN(SX, 0); pushN(SY, 0); i = i + 1; }
    acc = 0; f = 0;
    for (let a1 = 60; a1 > 0; a1--) {
      cx = Math.round(Math.cos(Math.PI * (f * 3) / 180) * 1e10) / 1e10; sx = Math.round(Math.sin(Math.PI * (f * 3) / 180) * 1e10) / 1e10; i = 1;
      for (let a2 = X.len; a2 > 0; a2--) {
        { // inlined rot(p0,p1,p2); cx,sx,tx,ty,tz stay promoted (no flush/reload)
          const p0 = (i >= 1 && i <= X.len && (x = X.f64[(i | 0) - 1], x === x)) ? x : X.getSlow(i), p1 = (i >= 1 && i <= Y.len && (x = Y.f64[(i | 0) - 1], x === x)) ? x : Y.getSlow(i), p2 = (i >= 1 && i <= Z.len && (x = Z.f64[(i | 0) - 1], x === x)) ? x : Z.getSlow(i);
          const n0 = typeof p0 === 'number' ? (p0 === p0 ? p0 : 0) : toNum(p0), n2 = typeof p2 === 'number' ? (p2 === p2 ? p2 : 0) : toNum(p2);
          tx = n0 * cx - n2 * sx; tz = n0 * sx + n2 * cx; ty = p1; }
        if (tz + 300 > 1) { d = tz + 300;
          q = tx * 240 / d; if (i >= 1 && i <= SX.len && SX.objs.length === 0) SX.f64[(i | 0) - 1] = q; else SX.setSlow(i, q);
          q = (typeof ty === 'number' ? (ty === ty ? ty : 0) : toNum(ty)) * 240 / d; if (i >= 1 && i <= SY.len && SY.objs.length === 0) SY.f64[(i | 0) - 1] = q; else SY.setSlow(i, q);
          acc = acc + ((i >= 1 && i <= SX.len && (x = SX.f64[(i | 0) - 1], x === x)) ? x : SX.numSlow(i)); }
        i = i + 1; }
      f = f + 1; }
    g.i.value = i; g.acc.value = acc; g.f.value = f; g.cx.value = cx; g.sx.value = sx; g.tx.value = tx; g.ty.value = ty; g.tz.value = tz; };
  out.push(bench('proj3d', () => { run(); return g.acc.value; })); }

// ===== grid (mixed list: '' markers + numbers) =====
{ const g = {i: V('i'), sum: V('sum')}; const G = new TList();
  const run = () => { let i, sum, x, o, q, r;
    G.clear(); for (let a0 = 100000; a0 > 0; a0--) G.pushSlow('');   // non-number push: slow path (out of line)
    for (let a1 = 20; a1 > 0; a1--) { i = 1;
      for (let a2 = G.len; a2 > 0; a2--) {
        // item i of G = ""  : compare with non-numeric constant string => number can never be equal
        x = (i >= 1 && i <= G.len && (o = G.f64[(i | 0) - 1], o === o)) ? o : G.getSlow(i);
        if (typeof x === 'number' ? false : eqSlow(x, '')) {
          r = (i >= 0 && i <= 9007199254740991 && i === Math.floor(i)) ? i - Math.floor(i / 3) * 3 : modSlow(i, 3);
          if (r === 0) { q = i * 0.5; if (i >= 1 && i <= G.len) { G.f64[(i | 0) - 1] = q; if (G.objs.length !== 0) G.objs[(i | 0) - 1] = undefined; } else G.setSlow(i, q); }
        } else { q = (typeof x === 'number' ? (x === x ? x : 0) : toNum(x)) + 1.5; if (i >= 1 && i <= G.len) { G.f64[(i | 0) - 1] = q; if (G.objs.length !== 0) G.objs[(i | 0) - 1] = undefined; } else G.setSlow(i, q); }
        i = i + 1; } }
    G.upToDate = false;
    sum = 0; i = 1;
    for (let a3 = G.len; a3 > 0; a3--) { sum = sum + ((i >= 1 && i <= G.len && (x = G.f64[(i | 0) - 1], x === x)) ? x : G.numSlow(i)); i = i + 1; }
    g.i.value = i; g.sum.value = sum; };
  out.push(bench('grid', () => { run(); return g.sum.value; })); }

// ===== queue =====
{ const g = {i: V('i'), sum: V('sum'), f: V('f')}; const Q = new TList();
  const run = () => { let i, sum, f, x, q; sum = 0; f = 0;
    for (let a0 = 200; a0 > 0; a0--) { Q.clear(); i = 0;
      for (let a1 = 5000; a1 > 0; a1--) { q = i * 1.25 + f; if (Q.len >= 0 && Q.len < Q.f64.length && Q.objs.length === 0) Q.f64[Q.len++] = q; else Q.pushSlow(q); i = i + 1; }
      i = 1; for (let a2 = Q.len; a2 > 0; a2--) { sum = sum + ((i >= 1 && i <= Q.len && (x = Q.f64[(i | 0) - 1], x === x)) ? x : Q.numSlow(i)); i = i + 1; }
      f = f + 1; }
    Q.upToDate = false; g.i.value = i; g.sum.value = sum; g.f.value = f; };
  out.push(bench('queue', () => { run(); return g.sum.value; })); }

const tw = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'tw-results.json'), 'utf8'));
let gm = 1, n = 0;
console.log('benchmark   TW(ms)   TTW(ms)  speedup  result-match');
for (const o of out) { const t = tw[o.name]; const sp = t.min / o.min; gm *= sp; n++; console.log(o.name.padEnd(10), String(t.min).padStart(7), String(o.min).padStart(9), (sp.toFixed(2) + 'x').padStart(8), ' ', t.result === o.result ? 'OK' : `MISMATCH tw=${t.result} ttw=${o.result}`); }
console.log('geomean speedup', Math.pow(gm, 1 / n).toFixed(2) + 'x');
