/* eslint-disable require-atomic-updates, max-len */
/**
 * @fileoverview Shared helpers for TurboTurboWarp tests: run a project deterministically with a given
 * backend and capture everything observable (spec 08 T2).
 */
const VM = require('../../src/virtual-machine');
const Thread = require('../../src/engine/thread');
const makeTestStorage = require('../fixtures/make-test-storage');
const log = require('../../src/util/log');

/**
 * Deterministic replacements for Date.now and Math.random while a project runs.
 * Every Date.now() call advances the clock by 1ms, so timing depends only on the sequence of calls.
 * @returns {Function} restore
 */
const installDeterminism = () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    let now = 1700000000000;
    Date.now = () => now++;
    let seed = 123456789;
    Math.random = () => {
        // xorshift32
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return ((seed >>> 0) % 1000000) / 1000000;
    };
    return () => {
        Date.now = realNow;
        Math.random = realRandom;
    };
};

const describeValue = v => [typeof v, v];

/**
 * @param {*} vm vm
 * @returns {Array} observable state of every target's variables and lists
 */
const captureState = vm => {
    const out = [];
    for (const target of vm.runtime.targets) {
        const vars = [];
        for (const id of Object.keys(target.variables).sort()) {
            const v = target.variables[id];
            if (v.type === 'list') {
                vars.push([v.name, 'list', v._tl.toArray().map(describeValue)]);
            } else if (v.type === '') {
                vars.push([v.name, '', describeValue(v.value)]);
            }
        }
        out.push([target.getName(), target.isOriginal, vars]);
    }
    return out;
};

/**
 * @param {Buffer|string} projectData project
 * @param {object} options options
 * @param {'tw'|'ttw'} options.backend backend
 * @param {boolean} [options.warpTimer] warp timer
 * @param {boolean} [options.enabled] compiler enabled
 * @param {number} [options.maxSteps] step limit
 * @param {Function} [options.setup] called with the VM before loading
 * @returns {Promise<object>} result
 */
const runProject = async (projectData, options) => {
    const restore = installDeterminism();
    const originalLogWarn = log.warn;
    const originalLogError = log.error;
    log.warn = () => {};
    let threadsTTW = 0;
    let threadsTW = 0;
    const originalTryCompile = Thread.prototype.tryCompile;
    Thread.prototype.tryCompile = function () {
        originalTryCompile.call(this);
        if (this.ttw) threadsTTW++;
        else if (this.isCompiled) threadsTW++;
    };
    try {
        const vm = new VM();
        vm.attachStorage(makeTestStorage());
        vm.setCompilerOptions({
            backend: options.backend,
            warpTimer: !!options.warpTimer,
            enabled: options.enabled !== false
        });
        const says = [];
        const compileErrors = [];
        vm.on('COMPILE_ERROR', (target, error) => compileErrors.push(String(error)));
        vm.runtime.on('SAY', (target, type, text) => {
            says.push([target.getName(), type, describeValue(text)]);
        });
        if (options.setup) options.setup(vm);
        await vm.loadProject(projectData);
        vm.greenFlag();
        const maxSteps = options.maxSteps || 3000;
        let steps = 0;
        const isActive = () => vm.runtime.threads.some(t => !t.updateMonitor);
        while (isActive() && steps < maxSteps) {
            vm.runtime._step();
            steps++;
        }
        const result = {
            says,
            state: captureState(vm),
            steps,
            compileErrors,
            ttwErrors: vm.runtime.ttw ? vm.runtime.ttw.errors.map(e => String((e && e.stack) || e)) : [],
            threadsTTW,
            threadsTW,
            vm
        };
        vm.stopAll();
        return result;
    } finally {
        Thread.prototype.tryCompile = originalTryCompile;
        log.warn = originalLogWarn;
        log.error = originalLogError;
        restore();
    }
};

/**
 * @param {object} a result
 * @param {object} b result
 * @returns {string|null} description of the first difference, or null
 */
const compareResults = (a, b) => {
    const sameValue = (x, y) => {
        if (Array.isArray(x) && Array.isArray(y)) {
            if (x.length !== y.length) return false;
            for (let i = 0; i < x.length; i++) if (!sameValue(x[i], y[i])) return false;
            return true;
        }
        if (x && y && typeof x === 'object' && typeof y === 'object') {
            return JSON.stringify(x) === JSON.stringify(y);
        }
        return Object.is(x, y);
    };
    if (!sameValue(a.says, b.says)) {
        for (let i = 0; i < Math.max(a.says.length, b.says.length); i++) {
            if (!sameValue(a.says[i], b.says[i])) {
                return `say #${i}: ${JSON.stringify(a.says[i])} vs ${JSON.stringify(b.says[i])}`;
            }
        }
    }
    if (!sameValue(a.state, b.state)) {
        for (let t = 0; t < Math.max(a.state.length, b.state.length); t++) {
            if (!sameValue(a.state[t], b.state[t])) {
                return `state of target #${t}: ${JSON.stringify(a.state[t]).slice(0, 400)} vs ${JSON.stringify(b.state[t]).slice(0, 400)}`;
            }
        }
    }
    if (a.steps !== b.steps) return `steps: ${a.steps} vs ${b.steps}`;
    return null;
};

module.exports = {
    runProject,
    compareResults,
    installDeterminism,
    captureState
};
