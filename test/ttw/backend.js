/**
 * @fileoverview TurboTurboWarp backend behaviour tests: entry guard failure (spec 08 T5),
 * invalidation (T6), list save/load round trip and externalization through the VM (T4).
 */
const {test} = require('node:test');
const assert = require('node:assert');
const VM = require('../../src/virtual-machine');
const {Proj, H} = require('../ttw-bench/sb');

const {add, get, set, chg, repeat, call, push, item, llen} = H;

const stageVar = (vm, name) => Object.values(vm.runtime.getTargetForStage().variables).find(v => v.name === name);

const runToEnd = vm => {
    vm.greenFlag();
    let guard = 0;
    while (vm.runtime.threads.length > 0 && guard++ < 10000) vm.runtime._step();
};

const makeVM = async (json, backend) => {
    const vm = new VM();
    vm.setCompilerOptions({backend});
    await vm.loadProject(json);
    return vm;
};

// x is read before it is written, so the native procedure guards it (it is program-NUM).
const guardProject = () => {
    const p = new Proj();
    const x = p.v('x');
    const y = p.v('y');
    p.define('run', [], true, [repeat(10, [chg(x, 1)]), set(y, add(get(x), get(x)))]);
    p.flag([call(p, 'run', [])]);
    return p.json();
};

test('T5: entry guard failure runs the generic twin with identical results', async () => {
    for (const value of ['abc', '5', '', true, 7.5]) {
        const results = [];
        for (const backend of ['tw', 'ttw']) {
            const vm = await makeVM(guardProject(), backend);
            // Compile first, then change the value behind the compiler's back (like a slider would).
            vm.runtime.precompile();
            const x = stageVar(vm, 'x');
            vm.setVariableValue(vm.runtime.getTargetForStage().id, x.id, value);
            runToEnd(vm);
            results.push([x.value, stageVar(vm, 'y').value]);
            if (backend === 'ttw') {
                assert.deepStrictEqual(vm.runtime.ttw.errors, []);
                assert.ok(/fp_\d+\$g/.test(vm.runtime.ttw.getModule(vm.runtime.getTargetForStage()).source),
                    'module has a generic twin');
            }
        }
        assert.deepStrictEqual(results[1], results[0], `initial value ${JSON.stringify(value)}`);
    }
});

test('T6: editing blocks invalidates compiled modules', async () => {
    const vm = await makeVM(guardProject(), 'ttw');
    runToEnd(vm);
    assert.strictEqual(stageVar(vm, 'y').value, 20);
    const stage = vm.runtime.getTargetForStage();
    const before = stage.blocks._cache.ttwModule;
    assert.ok(before, 'module was compiled');
    // Change the "repeat 10" count to 3.
    const repeatBlock = Object.values(stage.blocks._blocks).find(b => b.opcode === 'control_repeat');
    const times = stage.blocks._blocks[repeatBlock.inputs.TIMES.block];
    stage.blocks.changeBlock({id: times.id, element: 'field', name: Object.keys(times.fields)[0], value: '3'});
    stageVar(vm, 'x').value = 0;
    runToEnd(vm);
    assert.notStrictEqual(stage.blocks._cache.ttwModule, before, 'module was rebuilt');
    assert.strictEqual(stageVar(vm, 'y').value, 6);
});

test('T6: creating a variable invalidates compiled modules', async () => {
    const vm = await makeVM(guardProject(), 'ttw');
    runToEnd(vm);
    const epoch = vm.runtime.ttw.epoch;
    vm.runtime.getTargetForStage().createVariable('new-id', 'new variable', '');
    assert.ok(vm.runtime.ttw.epoch > epoch);
});

test('T4: lists survive save/load and external access through the VM', async () => {
    const p = new Proj();
    const L = p.l('L', ['1', 'a', '2.50', '']);
    const n = p.v('n');
    p.define('run', [], true, [push(L, 3), push(L, 'b'), set(n, add(item(L, 1), llen(L)))]);
    p.flag([call(p, 'run', [])]);
    const vm = await makeVM(p.json(), 'ttw');
    const list = Object.values(vm.runtime.getTargetForStage().variables).find(v => v.name === 'L');
    // Load-time normalization: '1' becomes a number; '2.50' is not canonical and stays a string.
    assert.deepStrictEqual(list.value, [1, 'a', '2.50', '']);
    runToEnd(vm);
    assert.strictEqual(stageVar(vm, 'n').value, 7);
    // An extension modifies the list through .value; the project sees it at the next safepoint.
    list.value.push(10);
    runToEnd(vm);
    assert.strictEqual(stageVar(vm, 'n').value, 1 + 9);
    const json = vm.toJSON();
    const vm2 = await makeVM(json, 'ttw');
    const list2 = Object.values(vm2.runtime.getTargetForStage().variables).find(v => v.name === 'L');
    assert.deepStrictEqual(list2.value, list.value);
});

test('07 §4: oversized native procedures are split into part functions', async () => {
    const p = new Proj();
    const x = p.v('x');
    const y = p.v('y');
    const L = p.l('L');
    const body = [set(x, 0), set(y, 1)];
    for (let i = 0; i < 700; i++) {
        body.push(chg(x, add(get(y), i % 7)));
        if (i % 50 === 0) body.push(push(L, get(x)));
    }
    p.define('run', [], true, body);
    p.flag([call(p, 'run', [])]);
    const results = [];
    for (const backend of ['tw', 'ttw']) {
        const vm = await makeVM(p.json(), backend);
        runToEnd(vm);
        const list = Object.values(vm.runtime.getTargetForStage().variables).find(v => v.name === 'L');
        results.push([stageVar(vm, 'x').value, list.value, list._monitorUpToDate]);
        if (backend === 'ttw') {
            assert.ok(/\$part1/.test(vm.runtime.ttw.getModule(vm.runtime.getTargetForStage()).source));
        }
    }
    assert.deepStrictEqual(results[1], results[0]);
});
