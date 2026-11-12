/**
 * @fileoverview Pattern Lab (spec 07 §3): the code shapes the TTW emitter produces ("adopted") next to the
 * ideal shape for the same work ("ideal"). Each body runs N iterations with `i` from 1 to N.
 * `setup` runs once and may define L (a TList with N numbers), P (a PURE TList), M (a mixed TList), etc.
 */
const N = 1000000;

const setup = `
const {TList} = R;
const L = new TList(); for (let k = 0; k < N; k++) L.pushSlow((k * 7919) % 1000);
const M = new TList(); for (let k = 0; k < N; k++) M.pushSlow(k % 10 === 0 ? 'x' : (k * 7919) % 1000);
const A = []; for (let k = 0; k < N; k++) A.push(k % 10 === 0 ? 'x' : (k * 7919) % 1000);
const F = new Float64Array(N); for (let k = 0; k < N; k++) F[k] = (k * 7919) % 1000;
const V = {value: 0};
`;

const patterns = {
    'list read (numeric, general)': {
        ideal: 'acc += F[i - 1];',
        adopted: 'acc += ((i >= 1 && i <= L.len && (x = L.f64[(i | 0) - 1]) === x) ? x : L.numSlow(i));'
    },
    'list read (numeric, PURE)': {
        ideal: 'acc += F[i - 1];',
        adopted: 'acc += ((i >= 1 && i <= L.len && (x = L.f64[(i | 0) - 1]) === x) ? x : 0);'
    },
    'list read (any, general, mixed list)': {
        // Ideal: a plain JS array holding the same mixed values (TW's representation).
        ideal: 'o = A[i - 1]; acc += (typeof o === "number" ? o : 0);',
        adopted: 'o = ((i >= 1 && i <= M.len) ? (k = (i | 0) - 1, (x = M.f64[k]) === x ? x : ((o2 = M.objs[k]) === undefined ? NaN : o2)) : ""); acc += (typeof o === "number" ? o : 0);'
    },
    'list read (any, PURE)': {
        ideal: 'o = F[i - 1]; acc += o;',
        adopted: 'o = ((i >= 1 && i <= L.len) ? L.f64[(i | 0) - 1] : ""); acc += o;'
    },
    'list store (number)': {
        ideal: 'F[i - 1] = i;',
        adopted: 'v = i; if (i >= 1 && i <= L.len) { L.f64[k = (i | 0) - 1] = v; if (L.objs.length !== 0 && L.objs[k] !== undefined) L.clearObj(k); }'
    },
    'list push (number)': {
        pre: 'L.clear(); Q.length = 0;',
        ideal: 'Q.push(i);',
        adopted: 'if (L.len < L.f64.length && L.objs.length === 0) L.f64[L.len++] = i; else L.pushSlow(i);'
    },
    'mod by constant': {
        ideal: 'acc += (i * 3) % 7;',
        adopted: 'acc += ((q = i * 3) >= 0 && (q | 0) === q ? q % 7 : q >= 1 && q <= 4503599627370496 && q === Math.floor(q) ? ((t = q - Math.floor(q / 7) * 7) < 0 ? t + 7 : (t >= 7 ? t - 7 : t)) : (t = q % 7, t / 7 < 0 ? t + 7 : t));'
    },
    'compare (both ANY, inline)': {
        ideal: 'a = i & 1023; b = 512; if (a === b) acc++;',
        adopted: 'a = i & 1023; b = 512; if ((((typeof a === "number" && typeof b === "number" && a === a && b === b) || a === b) ? a === b : eqSlow(a, b))) acc++;'
    },
    'entry guard': {
        ideal: 'acc += g(i);',
        adopted: 'acc += gg(i);',
        defs: 'const g = n => n + 1; const gg = n => { const v = V.value; if (typeof v !== "number") return 0; return n + 1; };'
    },
    'flush at exit': {
        ideal: 'acc += f1(i);',
        adopted: 'acc += f2(i);',
        defs: 'const f1 = n => { let w = n; w = w * 2; return w; }; const f2 = n => { let w = V.value; w = n * 2; V.value = w; return w; };'
    }
};

module.exports = {patterns, setup, N};
