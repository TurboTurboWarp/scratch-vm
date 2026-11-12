/**
 * @fileoverview TTW-Bench (spec 08 §2): run every program on the real VM with the TW and TTW backends.
 *
 *   node test/ttw-bench/run.js [names...] [--warptimer] [--json out.json]
 *
 * Reports the minimum of 7 runs for each backend and the speedup. Results must match between backends.
 */
const path = require('path');
const fs = require('fs');
const VM = require('../../src/virtual-machine');
const log = require('../../src/util/log');
const P = require('./programs');
const sys = require('./sys');

log.warn = () => {};

const args = process.argv.slice(2);
const warpTimer = args.includes('--warptimer');
const jsonIndex = args.indexOf('--json');
const jsonOut = jsonIndex !== -1 ? args[jsonIndex + 1] : null;
const names = args.filter((a, i) => !a.startsWith('-') && (jsonIndex === -1 || i !== jsonIndex + 1));

const REPS = +(process.env.TTW_BENCH_REPS || 7);

const timeProgram = async (name, backend) => {
    const {p, result} = P[name]();
    const vm = new VM();
    vm.setCompilerOptions(Object.assign({warpTimer, backend}, JSON.parse(process.env.TTW_BENCH_OPTS || '{}')));
    vm.on('COMPILE_ERROR', (t, e) => console.error('COMPILE_ERROR', e));
    await vm.loadProject(p.json());
    const stage = vm.runtime.getTargetForStage();
    const times = [];
    for (let r = 0; r < REPS; r++) {
        const t0 = process.hrtime.bigint();
        vm.greenFlag();
        let guard = 0;
        while (vm.runtime.threads.length > 0) {
            vm.runtime._step();
            if (++guard > 1e7) throw new Error('stuck');
        }
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const rv = Object.values(stage.variables).find(v => v.name === result).value;
    times.sort((a, b) => a - b);
    return {min: times[0], result: rv, ttwErrors: vm.runtime.ttw ? vm.runtime.ttw.errors.length : 0};
};

(async () => {
    const out = {};
    let gm = 1;
    let n = 0;
    console.log(`TTW-Bench (${warpTimer ? 'warp timer' : 'no warp timer'}), node ${process.version}`);
    console.log('program        TW(ms)    TTW(ms)   speedup  result');
    const list = names.length ? names.filter(x => P[x]) : Object.keys(P);
    for (const name of list) {
        const tw = await timeProgram(name, 'tw');
        const ttw = await timeProgram(name, 'ttw');
        const speedup = tw.min / ttw.min;
        gm *= speedup;
        n++;
        const ok = Object.is(tw.result, ttw.result) ? 'OK' : `MISMATCH tw=${tw.result} ttw=${ttw.result}`;
        out[name] = {tw: +tw.min.toFixed(2), ttw: +ttw.min.toFixed(2), speedup: +speedup.toFixed(2), match: ok === 'OK'};
        console.log(name.padEnd(12), tw.min.toFixed(1).padStart(8), ttw.min.toFixed(1).padStart(10), `${speedup.toFixed(2)}x`.padStart(9), ` ${ok}${ttw.ttwErrors ? ' (TTW fallback!)' : ''}`);
    }
    if (!names.length || names.some(x => !P[x])) {
        for (const r of await sys.run(names.filter(x => !P[x]))) {
            const speedup = r.tw / r.ttw;
            gm *= speedup;
            n++;
            out[r.name] = {tw: +r.tw.toFixed(4), ttw: +r.ttw.toFixed(4), speedup: +speedup.toFixed(2), match: r.match, unit: r.unit};
            console.log(r.name.padEnd(12), r.tw.toFixed(3).padStart(8), r.ttw.toFixed(3).padStart(10), `${speedup.toFixed(2)}x`.padStart(9), ` ${r.match ? 'OK' : 'MISMATCH'} (${r.unit})`);
        }
    }
    const geomean = Math.pow(gm, 1 / n);
    console.log(`geomean speedup ${geomean.toFixed(2)}x over ${n} programs`);
    out.geomean = +geomean.toFixed(2);
    if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(out, null, 1));
    process.exit(0);
})();
