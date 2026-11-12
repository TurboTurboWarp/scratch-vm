/**
 * @fileoverview TTW-Bench in a browser (spec 08 §2 / 09 P1). Bundled by webpack.ttw-bench.config.js.
 * Open test/ttw-bench/browser.html; results are written to the page (and window.ttwBenchResults).
 */
const VM = require('../../src/virtual-machine');
const P = require('./programs');
const sys = require('./sys');

const out = document.getElementById('out');
const log = line => {
    out.textContent += `${line}\n`;
};
const now = () => performance.now();
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

const timeProgram = async (name, backend, warpTimer, extra) => {
    const {p, result} = P[name]();
    const vm = new VM();
    vm.setCompilerOptions(Object.assign({warpTimer, backend}, extra || {}));
    await vm.loadProject(p.json());
    const times = [];
    for (let r = 0; r < 7; r++) {
        const t0 = now();
        vm.greenFlag();
        while (vm.runtime.threads.length > 0) vm.runtime._step();
        times.push(now() - t0);
        await pause();
    }
    const rv = Object.values(vm.runtime.getTargetForStage().variables).find(v => v.name === result).value;
    return {min: Math.min(...times), result: rv};
};

const run = async () => {
    const warpTimer = location.hash.includes('warptimer');
    const results = {userAgent: navigator.userAgent, warpTimer, programs: {}};
    log(`TTW-Bench in ${navigator.userAgent} (${warpTimer ? 'warp timer' : 'no warp timer'})`);
    let gm = 1;
    let n = 0;
    for (const name of Object.keys(P)) {
        const tw = await timeProgram(name, 'tw', warpTimer);
        const ttw = await timeProgram(name, 'ttw', warpTimer);
        const speedup = tw.min / ttw.min;
        gm *= speedup;
        n++;
        results.programs[name] = {tw: tw.min, ttw: ttw.min, speedup, match: Object.is(tw.result, ttw.result)};
        log(`${name.padEnd(10)} TW ${tw.min.toFixed(2).padStart(8)}ms  TTW ${ttw.min.toFixed(2).padStart(8)}ms  ${speedup.toFixed(2)}x ${Object.is(tw.result, ttw.result) ? 'OK' : 'MISMATCH'}`);
        await pause();
    }
    if (!warpTimer) {
        for (const r of await sys.run([], now)) {
            const speedup = r.tw / r.ttw;
            gm *= speedup;
            n++;
            results.programs[r.name] = {tw: r.tw, ttw: r.ttw, speedup, match: r.match, unit: r.unit};
            log(`${r.name.padEnd(10)} TW ${r.tw.toFixed(3).padStart(8)}  TTW ${r.ttw.toFixed(3).padStart(8)}  ${speedup.toFixed(2)}x (${r.unit})`);
        }
    }
    results.geomean = Math.pow(gm, 1 / n);
    log(`geomean ${results.geomean.toFixed(2)}x over ${n}`);
    log('DONE');
    window.ttwBenchResults = results;
};

window.TTW = {VM, P, timeProgram};
if (!location.hash.includes('manual')) run().catch(e => log(`ERROR ${e && e.stack}`));
