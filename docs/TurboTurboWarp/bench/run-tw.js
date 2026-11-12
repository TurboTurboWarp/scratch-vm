const path = require('path'); const fs = require('fs');
const VMDIR = '/home/claude/src/scratch-vm';
const VM = require(path.join(VMDIR, 'src/virtual-machine'));
const JSGenerator = require(path.join(VMDIR, 'src/compiler/jsgen'));
const P = require('./programs');
const names = process.argv.slice(2).filter(a => !a.startsWith('-')); const warpTimer = process.argv.includes('--warptimer'); const interp = process.argv.includes('--interp');
(async () => {
  const out = {};
  for (const name of (names.length ? names : Object.keys(P))) {
    const {p, result} = P[name]();
    const vm = new VM(); vm.setCompilerOptions({warpTimer, enabled: !interp});
    const srcs = []; JSGenerator.testingApparatus = {report: (g, s) => srcs.push(s)};
    vm.on('COMPILE_ERROR', (t, e) => console.error('COMPILE_ERROR', e));
    await vm.loadProject(p.json());
    const stage = vm.runtime.getTargetForStage();
    const times = [];
    const reps = interp ? 2 : 7;
    for (let r = 0; r < reps; r++) {
      const t0 = process.hrtime.bigint();
      vm.greenFlag();
      let guard = 0;
      while (vm.runtime.threads.length > 0) { vm.runtime._step(); if (++guard > 1e7) throw new Error('stuck'); }
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const rv = Object.values(stage.variables).find(v => v.name === result).value;
    fs.mkdirSync('gen', {recursive: true}); if (!interp) fs.writeFileSync(`gen/${name}${warpTimer ? '.wt' : ''}.js`, srcs.join('\n\n'));
    times.sort((a, b) => a - b);
    out[name] = {min: +times[0].toFixed(1), med: +times[times.length >> 1].toFixed(1), result: rv};
    console.log(name.padEnd(9), 'min', String(out[name].min).padStart(8), 'med', String(out[name].med).padStart(8), 'result', rv);
  }
  fs.writeFileSync(`tw-results${warpTimer ? '-wt' : ''}${interp ? '-interp' : ''}.json`, JSON.stringify(out, null, 1));
  process.exit(0);
})();
