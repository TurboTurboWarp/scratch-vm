'use strict';
const {TList, toNum, modSlow} = require('./rt');
const T = (name, fn, reps = 15) => { const ts = []; let r; for (let i = 0; i < reps; i++) { const t0 = process.hrtime.bigint(); r = fn(); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); } ts.sort((a, b) => a - b); console.log(name.padEnd(58), 'min', ts[0].toFixed(2).padStart(7), 'med', ts[ts.length >> 1].toFixed(2).padStart(7), r); };
const X = new TList(), Y = new TList(), Z = new TList(), SX = new TList(), SY = new TList();
const pushN = (L, v) => { if (L.len < L.f64.length && L.objs.length === 0) L.f64[L.len++] = v; else L.pushSlow(v); };
const build = () => { X.clear(); Y.clear(); Z.clear(); SX.clear(); SY.clear(); let i = 0, q;
  for (let a0 = 20000; a0 > 0; a0--) { q = i * 37; pushN(X, ((q >= 0 && q <= 9007199254740991 && q === Math.floor(q)) ? q - Math.floor(q / 200) * 200 : modSlow(q, 200)) - 100); q = i * 91; pushN(Y, ((q >= 0 && q <= 9007199254740991 && q === Math.floor(q)) ? q - Math.floor(q / 200) * 200 : modSlow(q, 200)) - 100); q = i * 53; pushN(Z, ((q >= 0 && q <= 9007199254740991 && q === Math.floor(q)) ? q - Math.floor(q / 200) * 200 : modSlow(q, 200)) - 100); pushN(SX, 0); pushN(SY, 0); i = i + 1; } };
T('build only', () => { build(); return X.len; });
build();
// A: any-typed args, generic guards everywhere (what the proto did)
T('frames A: generic guards (any-typed p0/p1/p2/ty)', () => { let i, acc = 0, f = 0, cx, sx, tx, ty, tz, x, q, d;
  for (let a1 = 60; a1 > 0; a1--) { cx = Math.round(Math.cos(Math.PI * (f * 3) / 180) * 1e10) / 1e10; sx = Math.round(Math.sin(Math.PI * (f * 3) / 180) * 1e10) / 1e10; i = 1;
    for (let a2 = X.len; a2 > 0; a2--) {
      const p0 = (i >= 1 && i <= X.len && (x = X.f64[(i | 0) - 1], x === x)) ? x : X.getSlow(i), p1 = (i >= 1 && i <= Y.len && (x = Y.f64[(i | 0) - 1], x === x)) ? x : Y.getSlow(i), p2 = (i >= 1 && i <= Z.len && (x = Z.f64[(i | 0) - 1], x === x)) ? x : Z.getSlow(i);
      const n0 = typeof p0 === 'number' ? (p0 === p0 ? p0 : 0) : toNum(p0), n2 = typeof p2 === 'number' ? (p2 === p2 ? p2 : 0) : toNum(p2);
      tx = n0 * cx - n2 * sx; tz = n0 * sx + n2 * cx; ty = p1;
      if (tz + 300 > 1) { d = tz + 300; q = tx * 240 / d; if (i >= 1 && i <= SX.len && SX.objs.length === 0) SX.f64[(i | 0) - 1] = q; else SX.setSlow(i, q);
        q = (typeof ty === 'number' ? (ty === ty ? ty : 0) : toNum(ty)) * 240 / d; if (i >= 1 && i <= SY.len && SY.objs.length === 0) SY.f64[(i | 0) - 1] = q; else SY.setSlow(i, q);
        acc = acc + ((i >= 1 && i <= SX.len && (x = SX.f64[(i | 0) - 1], x === x)) ? x : SX.numSlow(i)); }
      i = i + 1; } f = f + 1; } return acc; });
// B: region versioning: pre-header guard "X,Y,Z,SX,SY numeric-only" => reads are NUM|"" with constant cold values; no calls in the loop
T('frames B: versioned (numeric-only lists hoisted)', () => { let i, acc = 0, f = 0, cx, sx, tx, ty, tz, x, q, d, n0, n2, tyn, tyIsNum;
  for (let a1 = 60; a1 > 0; a1--) { cx = Math.round(Math.cos(Math.PI * (f * 3) / 180) * 1e10) / 1e10; sx = Math.round(Math.sin(Math.PI * (f * 3) / 180) * 1e10) / 1e10; i = 1;
    if (X.objs.length === 0 && Y.objs.length === 0 && Z.objs.length === 0 && SX.objs.length === 0 && SY.objs.length === 0) {
      for (let a2 = X.len; a2 > 0; a2--) {
        // numeric views of args: OOB "" -> 0, NaN -> 0   (p1 is only used numerically later, but is stored to ty as ANY: keep numeric twin + flag)
        n0 = (i >= 1 && i <= X.len && (x = X.f64[(i | 0) - 1], x === x)) ? x : 0;
        n2 = (i >= 1 && i <= Z.len && (x = Z.f64[(i | 0) - 1], x === x)) ? x : 0;
        if (i >= 1 && i <= Y.len) { tyn = Y.f64[(i | 0) - 1]; tyIsNum = true; } else { tyn = 0; tyIsNum = false; }      // ty = number (maybe NaN) or ""
        tx = n0 * cx - n2 * sx; tz = n0 * sx + n2 * cx;
        if (tz + 300 > 1) { d = tz + 300; if (i >= 1 && i <= SX.len) SX.f64[(i | 0) - 1] = tx * 240 / d;
          if (i >= 1 && i <= SY.len) SY.f64[(i | 0) - 1] = (tyn === tyn ? tyn : 0) * 240 / d;
          acc = acc + ((i >= 1 && i <= SX.len && (x = SX.f64[(i | 0) - 1], x === x)) ? x : 0); }
        i = i + 1; }
      ty = tyIsNum ? tyn : '';
    } else { throw new Error('generic twin'); }
    f = f + 1; } return acc; });
