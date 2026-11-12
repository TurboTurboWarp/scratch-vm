/**
 * @fileoverview Pattern Lab runner (spec 07 §3). Runs every pattern under the default V8 flags and
 * --no-use-osr in child processes and checks that the adopted form is within 2.5x of the ideal form.
 *
 *   node test/ttw-bench/patterns/run.js        # exits 1 if a pattern exceeds the limit
 */
const {execFileSync} = require('child_process');
const {patterns, setup, N} = require('./patterns');

const LIMIT = 2.5;

if (process.argv[2] === '--child') {
    const R = require('../../../src/ttw/rt/helpers');
    const name = process.argv[3];
    const kind = process.argv[4];
    const chunked = process.argv[5] === 'chunked';
    const p = patterns[name];
    // chunked: the loop runs in a function called every 4096 iterations, as TTW emits top-level loops (07 §5).
    const src = chunked ? `${setup}${p.defs || ''}
const Q = [];
const chunk = (B) => { let acc = B.acc, x = 0, k = 0, t = 0, q = 0, v = 0, a = 0, b = 0, o, o2; let i = B.i;
for (let n = 4096; i <= N && n > 0; i++, n--) { ${p[kind]} }
B.acc = acc; B.i = i; return i <= N; };
return () => { ${p.pre || ''} const B = {acc: 0, i: 1}; while (chunk(B)); return B.acc; };` : `${setup}${p.defs || ''}
const Q = [];
return () => { let acc = 0, x = 0, k = 0, t = 0, q = 0, v = 0, a = 0, b = 0, o, o2; ${p.pre || ''}
for (let i = 1; i <= N; i++) { ${p[kind]} }
return acc; };`;
    // eslint-disable-next-line no-new-func
    const run = new Function('R', 'N', 'eqSlow', src)(R, N, R.eqSlow);
    let best = Infinity;
    for (let r = 0; r < 7; r++) {
        const t0 = process.hrtime.bigint();
        run();
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / N);
    }
    process.stdout.write(String(best));
    process.exit(0);
}

const measure = (name, kind, flags, mode) => +execFileSync(process.execPath, [...flags, __filename, '--child', name, kind, mode]).toString();

// [label, flags, loop mode, gates the result]
const CONFIGS = [
    ['default/chunked', [], 'chunked', true],
    ['--no-use-osr', ['--no-use-osr'], 'plain', true],
    ['default/raw-osr', [], 'plain', false]
];

let failed = 0;
console.log(`${'pattern'.padEnd(40)} ${'config'.padEnd(16)} ideal ns  adopted ns  ratio`);
for (const name of Object.keys(patterns)) {
    for (const [label, flags, mode, gates] of CONFIGS) {
        const ideal = measure(name, 'ideal', flags, mode);
        const adopted = measure(name, 'adopted', flags, mode);
        // Sub-nanosecond ideals are dominated by noise; compare against at least 0.5ns.
        const ratio = adopted / Math.max(ideal, 0.5);
        const bad = gates && ratio > LIMIT;
        if (bad) failed++;
        const note = bad ? '  OVER LIMIT' : (!gates && ratio > LIMIT ? '  (07 F3: single long OSR loop, informational)' : '');
        console.log(`${name.padEnd(40)} ${label.padEnd(16)} ${ideal.toFixed(2).padStart(8)} ${adopted.toFixed(2).padStart(11)}  ${ratio.toFixed(2)}x${note}`);
    }
}
console.log(failed ? `${failed} pattern(s) over ${LIMIT}x` : `all patterns within ${LIMIT}x of ideal`);
process.exit(failed ? 1 : 0);
