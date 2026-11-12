/* eslint-disable max-len, global-require */
/**
 * @fileoverview Differential execution test (spec 08 T2): every project in test/fixtures/execute and every
 * TTW-Bench program is run with the TW backend and the TTW backend (warp timer off and on), comparing
 * say output, final variables and lists (typeof included, Object.is) and the number of _step calls.
 *
 * Run directly for a report: node test/ttw/differential.js --report [filter]
 */
const fs = require('fs');
const path = require('path');
const {runProject, compareResults} = require('./lib');
const programs = require('../ttw-bench/programs');

const executeDir = path.resolve(__dirname, '../fixtures/execute');

// Projects that are timing or environment dependent in ways unrelated to the backend.
const SKIP = new Set([
]);

const cases = [];
for (const file of fs.readdirSync(executeDir).filter(f => /\.sb[23]?$/i.test(f))
    .sort()) {
    if (SKIP.has(file)) continue;
    cases.push({name: file, load: () => fs.readFileSync(path.join(executeDir, file)), maxSteps: 2000});
}

// Small versions of the bench programs (correctness only).
for (const name of Object.keys(programs)) {
    cases.push({name: `bench:${name}`, load: () => programs[name]().p.json(), maxSteps: 100000, bench: true});
}

const runCase = async (c, warpTimer) => {
    const data = c.load();
    const tw = await runProject(data, {backend: 'tw', warpTimer, maxSteps: c.maxSteps});
    const ttw = await runProject(data, {backend: 'ttw', warpTimer, maxSteps: c.maxSteps});
    return {tw, ttw, diff: compareResults(tw, ttw)};
};

if (process.argv.includes('--report')) {
    const filter = process.argv.slice(2).filter(a => a !== '--report')[0] || '';
    (async () => {
        let failures = 0;
        for (const c of cases) {
            if (!c.name.includes(filter)) continue;
            if (c.bench && !filter) continue;
            for (const warpTimer of [false, true]) {
                const {tw, ttw, diff} = await runCase(c, warpTimer);
                const label = `${warpTimer ? 'wt ' : '   '}${c.name}`;
                const problems = [];
                if (diff) problems.push(diff);
                if (ttw.ttwErrors.length) {
                    problems.push(`ttw errors: ${ttw.ttwErrors[0].split('\n').slice(0, 3)
                        .join(' | ')}`);
                }
                if (ttw.compileErrors.length) problems.push(`compile errors: ${ttw.compileErrors[0]}`);
                if (ttw.threadsTW > 0) problems.push(`${ttw.threadsTW} threads fell back to TW (${ttw.threadsTTW} TTW)`);
                if (problems.length) {
                    failures++;
                    console.log('FAIL', label, problems.join('; '));
                } else {
                    console.log('ok  ', label, `steps=${tw.steps} ttwThreads=${ttw.threadsTTW}`);
                }
            }
        }
        console.log(failures ? `${failures} failures` : 'all ok');
        process.exit(failures ? 1 : 0);
    })();
} else {
    const {test} = require('node:test');
    const assert = require('node:assert');
    for (const c of cases) {
        if (c.bench) continue;
        for (const warpTimer of [false, true]) {
            test(`ttw differential: ${warpTimer ? 'warp-timer/' : ''}${c.name}`, async () => {
                const {ttw, diff} = await runCase(c, warpTimer);
                assert.strictEqual(diff, null, diff);
                assert.deepStrictEqual(ttw.ttwErrors, []);
                assert.strictEqual(ttw.threadsTW, 0, 'some threads fell back to the TW backend');
            });
        }
    }
}

module.exports = {cases, runCase};
