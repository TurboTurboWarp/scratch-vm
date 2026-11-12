const {Proj, H} = require('./sb');
const {add, sub, mul, div, mod, lt, gt, eq, and, or, not, math, join, letter, len, get, set, chg, item, llen, push, repl, clear, repeat, until, arg, ret, call} = H;
const P = {};
P.mandel = () => { const p = new Proj(); const [sum, px, py, x0, y0, x, y, xt, i] = ['sum', 'px', 'py', 'x0', 'y0', 'x', 'y', 'xt', 'i'].map(n => p.v(n));
  p.define('run', [], true, [set(sum, 0), set(py, 0), repeat(300, [set(px, 0), repeat(300, [
    set(x0, sub(mul(div(get(px), 300), 3.5), 2.5)), set(y0, sub(mul(div(get(py), 300), 2), 1)), set(x, 0), set(y, 0), set(i, 0),
    until(or(gt(add(mul(get(x), get(x)), mul(get(y), get(y))), 4), not(lt(get(i), 200))), [
      set(xt, add(sub(mul(get(x), get(x)), mul(get(y), get(y))), get(x0))), set(y, add(mul(mul(2, get(x)), get(y)), get(y0))), set(x, get(xt)), chg(i, 1)]),
    chg(sum, get(i)), chg(px, 1)]), chg(py, 1)])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'sum'}; };
P.sieve = () => { const p = new Proj(); const [n, i, j, count] = ['n', 'i', 'j', 'count'].map(v => p.v(v)); const flags = p.l('flags');
  p.define('run', [], true, [set(n, 1000000), clear(flags), repeat(get(n), [push(flags, 1)]), set(i, 2),
    until(gt(mul(get(i), get(i)), get(n)), [H.if(eq(item(flags, get(i)), 1), [set(j, mul(get(i), get(i))), until(gt(get(j), get(n)), [repl(flags, get(j), 0), chg(j, get(i))])]), chg(i, 1)]),
    set(count, 0), set(i, 2), repeat(sub(get(n), 1), [H.if(eq(item(flags, get(i)), 1), [chg(count, 1)]), chg(i, 1)])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'count'}; };
P.fib = () => { const p = new Proj(); const r = p.v('r');
  p.define('fib', ['n'], true, () => [H.if(lt(arg('n'), 2), [ret(arg('n'))]), ret(add(call(p, 'fib', [sub(arg('n'), 1)], true), call(p, 'fib', [sub(arg('n'), 2)], true)))]);
  p.define('run', [], true, [set(r, call(p, 'fib', [30], true))]);
  p.flag([call(p, 'run', [])]); return {p, result: 'r'}; };
P.calls = () => { const p = new Proj(); const [acc, i] = ['acc', 'i'].map(v => p.v(v));
  p.define('step', ['a', 'b'], true, [chg(acc, mod(mul(arg('a'), arg('b')), 7))]);
  p.define('run', [], true, [set(acc, 0), set(i, 0), repeat(3000000, [call(p, 'step', [get(i), add(get(i), 1)]), chg(i, 1)])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'acc'}; };
P.sort = () => { const p = new Proj(); const [seed, i, j, t, chk] = ['seed', 'i', 'j', 't', 'chk'].map(v => p.v(v)); const a = p.l('a');
  p.define('run', [], true, [clear(a), set(seed, 12345), repeat(3000, [set(seed, mod(add(mul(get(seed), 1103515245), 12345), 2147483648)), push(a, mod(get(seed), 100000))]),
    set(i, 2), repeat(sub(llen(a), 1), [set(t, item(a, get(i))), set(j, sub(get(i), 1)),
      until(or(lt(get(j), 1), not(gt(item(a, get(j)), get(t)))), [repl(a, add(get(j), 1), item(a, get(j))), chg(j, -1)]),
      repl(a, add(get(j), 1), get(t)), chg(i, 1)]),
    set(chk, add(item(a, 1), add(item(a, 1500), item(a, 3000))))]);
  p.flag([call(p, 'run', [])]); return {p, result: 'chk'}; };
P.strings = () => { const p = new Proj(); const [s, i, count] = ['s', 'i', 'count'].map(v => p.v(v));
  p.define('run', [], true, [set(s, ''), set(i, 0), repeat(100000, [set(s, join(get(s), letter(add(mod(get(i), 10), 1), 'abcdefghij'))), chg(i, 1)]),
    set(count, 0), set(i, 1), repeat(len(get(s)), [H.if(eq(letter(get(i), get(s)), 'c'), [chg(count, 1)]), chg(i, 1)])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'count'}; };
P.strlist = () => { const p = new Proj(); const [sum, i] = ['sum', 'i'].map(v => p.v(v)); const init = []; for (let k = 0; k < 100000; k++) init.push(String((k * 7919) % 1000));
  const d = p.l('data', init);
  p.define('run', [], true, [set(sum, 0), repeat(20, [set(i, 1), repeat(llen(d), [chg(sum, item(d, get(i))), chg(i, 1)])])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'sum'}; };
// 3D-ish: project points stored in lists (typical pen 3D engine inner loop without the pen)
P.proj3d = () => { const p = new Proj(); const [i, cx, sx, tx, ty, tz, acc, f] = ['i', 'cx', 'sx', 'tx', 'ty', 'tz', 'acc', 'f'].map(v => p.v(v));
  const X = p.l('X'), Y = p.l('Y'), Z = p.l('Z'), SX = p.l('SX'), SY = p.l('SY');
  p.define('rot', ['x', 'y', 'z'], true, [set(tx, sub(mul(arg('x'), get(cx)), mul(arg('z'), get(sx)))), set(tz, add(mul(arg('x'), get(sx)), mul(arg('z'), get(cx)))), set(ty, arg('y'))]);
  p.define('run', [], true, [clear(X), clear(Y), clear(Z), clear(SX), clear(SY), set(i, 0),
    repeat(20000, [push(X, sub(mod(mul(get(i), 37), 200), 100)), push(Y, sub(mod(mul(get(i), 91), 200), 100)), push(Z, sub(mod(mul(get(i), 53), 200), 100)), push(SX, 0), push(SY, 0), chg(i, 1)]),
    set(acc, 0), set(f, 0), repeat(60, [set(cx, math('cos', mul(get(f), 3))), set(sx, math('sin', mul(get(f), 3))), set(i, 1),
      repeat(llen(X), [call(p, 'rot', [item(X, get(i)), item(Y, get(i)), item(Z, get(i))]),
        H.if(gt(add(get(tz), 300), 1), [repl(SX, get(i), div(mul(get(tx), 240), add(get(tz), 300))), repl(SY, get(i), div(mul(get(ty), 240), add(get(tz), 300))), chg(acc, item(SX, get(i)))]),
        chg(i, 1)]), chg(f, 1)])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'acc'}; };
// mixed list: '' used as an "empty" marker inside an otherwise numeric list (very common idiom)
P.grid = () => { const p = new Proj(); const [i, sum] = ['i', 'sum'].map(v => p.v(v)); const g = p.l('G');
  p.define('run', [], true, [clear(g), repeat(100000, [push(g, '')]),
    repeat(20, [set(i, 1), repeat(llen(g), [H.ifelse(eq(item(g, get(i)), ''), [H.if(eq(mod(get(i), 3), 0), [repl(g, get(i), mul(get(i), 0.5))])], [repl(g, get(i), add(item(g, get(i)), 1.5))]), chg(i, 1)])]),
    set(sum, 0), set(i, 1), repeat(llen(g), [chg(sum, item(g, get(i))), chg(i, 1)])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'sum'}; };
// render-queue idiom: every "frame" delete all + add many + read back
P.queue = () => { const p = new Proj(); const [i, sum, f] = ['i', 'sum', 'f'].map(v => p.v(v)); const q = p.l('Q');
  p.define('run', [], true, [set(sum, 0), set(f, 0), repeat(200, [clear(q), set(i, 0), repeat(5000, [push(q, add(mul(get(i), 1.25), get(f))), chg(i, 1)]),
    set(i, 1), repeat(llen(q), [chg(sum, item(q, get(i))), chg(i, 1)]), chg(f, 1)])]);
  p.flag([call(p, 'run', [])]); return {p, result: 'sum'}; };
module.exports = P;
