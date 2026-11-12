// @ts-check
/* eslint-disable no-self-compare, no-undefined */


/**
 * @fileoverview Runtime library ("R") used by TurboTurboWarp generated modules.
 * Everything here is a slow path or a VM interaction; fast paths are inlined by the emitter (spec 07 R2/R3).
 * All semantics match TW's jsexecute.js exactly.
 */

const Timer = require('../../util/timer');
const Cast = require('../../util/cast');
const log = require('../../util/log');
const blockUtility = require('../../compiler/compat-block-utility');
const {TList, EMPTY_OBJS, extDirty, syncLists, isNotActuallyZero} = require('./tlist');

/**
 * Thrown by native (non-yielding) procedures to end the whole thread. Same value as TW's RETIRE_MAGIC.
 */
const RETIRE = 1;

/** Step function results (spec 05 §1). */
const YIELD = 0;
const SWITCH = 1;
const DONE = 2;

const STATUS_RUNNING = 0;
const STATUS_PROMISE_WAIT = 1;
const STATUS_YIELD = 2;
const STATUS_YIELD_TICK = 3;
const STATUS_DONE = 4;

/**
 * Make a stuck check with its own counter (same as TW's isStuck: check the real time once every 100
 * calls). TW has one counter per compiled script, so each unit gets one.
 * @param {*} runtime runtime
 * @returns {() => boolean} stuck check
 */
const makeStuck = runtime => {
    let counter = 0;
    return () => {
        counter++;
        if (counter === 100) {
            counter = 0;
            return runtime.sequencer.timer.timeElapsed() > 500;
        }
        return false;
    };
};

const toNum = v => {
    const n = +v;
    return n === n ? n : 0;
};

const toBoolean = value => {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        if (value === '' || value === '0' || value.toLowerCase() === 'false') {
            return false;
        }
        return true;
    }
    return !!value;
};

const limitPrecision = value => {
    const rounded = Math.round(value);
    const delta = value - rounded;
    return (Math.abs(delta) < 1e-9) ? rounded : value;
};

const eqSlow = (v1, v2) => {
    const n1 = +v1;
    if (n1 !== n1 || (n1 === 0 && isNotActuallyZero(v1))) return (`${v1}`).toLowerCase() === (`${v2}`).toLowerCase();
    const n2 = +v2;
    if (n2 !== n2 || (n2 === 0 && isNotActuallyZero(v2))) return (`${v1}`).toLowerCase() === (`${v2}`).toLowerCase();
    return n1 === n2;
};

const gtSlow = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isNotActuallyZero(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isNotActuallyZero(v2)) {
        n2 = NaN;
    }
    if (n1 !== n1 || n2 !== n2) {
        return (`${v1}`).toLowerCase() > (`${v2}`).toLowerCase();
    }
    return n1 > n2;
};

const ltSlow = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isNotActuallyZero(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isNotActuallyZero(v2)) {
        n2 = NaN;
    }
    if (n1 !== n1 || n2 !== n2) {
        return (`${v1}`).toLowerCase() < (`${v2}`).toLowerCase();
    }
    return n1 < n2;
};

const modSlow = (n, modulus) => {
    let result = n % modulus;
    if (result / modulus < 0) result += modulus;
    return result;
};

const randomInt = (low, high) => low + Math.floor(Math.random() * ((high + 1) - low));
const randomFloat = (low, high) => (Math.random() * (high - low)) + low;

const tan = angle => {
    angle = angle % 360;
    switch (angle) {
    case -270: case 90: return Infinity;
    case -90: case 270: return -Infinity;
    }
    return Math.round(Math.tan((Math.PI * angle) / 180) * 1e10) / 1e10;
};

const daysSince2000 = () => (Date.now() - 946684800000) / (24 * 60 * 60 * 1000);

const colorToList = color => Cast.toRgbColorList(color);

/**
 * @param {*} target target
 * @param {string} menu name of a sprite or _mouse_
 * @returns {number} distance
 */
const distance = (target, menu) => {
    if (target.isStage) return 10000;
    let targetX = 0;
    let targetY = 0;
    if (menu === '_mouse_') {
        targetX = target.runtime.ioDevices.mouse.getScratchX();
        targetY = target.runtime.ioDevices.mouse.getScratchY();
    } else {
        const distTarget = target.runtime.getSpriteTargetByName(menu);
        if (!distTarget) return 10000;
        targetX = distTarget.x;
        targetY = distTarget.y;
    }
    const dx = target.x - targetX;
    const dy = target.y - targetY;
    return Math.sqrt((dx * dx) + (dy * dy));
};

/**
 * @param {*} runtime runtime
 * @returns {Timer} started timer that uses the runtime's frame clock
 */
const timer = runtime => {
    const t = new Timer({
        now: () => runtime.currentMSecs
    });
    t.start();
    return t;
};

/**
 * End a thread (spec 06 §5).
 * @param {*} thread thread
 */
const retire = thread => {
    thread.target.runtime.sequencer.retireThread(thread);
};

/**
 * One poll of TW's waitThreads.
 * @param {*} thread waiting thread
 * @param {Array<*>} threads threads being waited on
 * @returns {boolean} true if the waiting thread must yield
 */
const waitThreads = (thread, threads) => {
    const runtime = thread.target.runtime;
    let anyRunning = false;
    const all = runtime.threads;
    for (let i = 0; i < threads.length; i++) {
        if (all.indexOf(threads[i]) !== -1) {
            anyRunning = true;
            break;
        }
    }
    if (!anyRunning) return false;
    let allWaiting = true;
    for (let i = 0; i < threads.length; i++) {
        if (!runtime.isWaitingThread(threads[i])) {
            allWaiting = false;
            break;
        }
    }
    if (allWaiting) {
        thread.status = STATUS_YIELD_TICK;
    }
    return true;
};

const isPromise = value => (
    value !== null &&
    typeof value === 'object' &&
    typeof value.then === 'function'
);

const createBranchInfo = isLoop => ({
    defaultIsLoop: isLoop,
    isLoop: false,
    branch: 0,
    stackFrame: {}
});

/**
 * @param {*} branchInfo branch info or null
 * @param {*} returnValue value returned by the block
 * @returns {*} TW's finish() result
 */
const compatFinish = (branchInfo, returnValue) => {
    if (branchInfo) {
        if (typeof returnValue === 'undefined' && blockUtility._startedBranch) {
            branchInfo.isLoop = blockUtility._startedBranch[1];
            return blockUtility._startedBranch[0];
        }
        branchInfo.isLoop = branchInfo.defaultIsLoop;
        return returnValue;
    }
    return returnValue;
};

/**
 * One execution of a block in the compatibility layer, as a resumable state (spec 05 §5).
 * Same semantics as TW's executeInCompatibilityLayer generator.
 * @param {*} thread thread
 * @param {*} inputs inputs object (evaluated once per invocation)
 * @param {*} stackFrame stack frame object (persists across retries of one invocation)
 * @param {Function} blockFunction primitive
 * @param {Function|null} stuckFn the calling unit's stuck check if it is warp, otherwise null
 * @param {string} blockId block ID
 * @param {*} branchInfo branch info or null
 * @param {boolean} again true when this is a re-execution after a yield
 * @returns {number} 0: done (value in thread.ret); 1: yield, then re-execute; 2: yield, then continue
 * (value in thread.ret once resumed); 3: re-execute immediately
 */
const compatCall = (thread, inputs, stackFrame, blockFunction, stuckFn, blockId, branchInfo, again) => {
    thread.fromPromise = false;
    thread.compatPending = false;
    blockUtility.init(thread, blockId, stackFrame);
    const returnValue = blockFunction(inputs, blockUtility);
    if (isPromise(returnValue)) {
        // enter STATUS_PROMISE_WAIT and yield; finish() is applied when the thread resumes (compatResume)
        thread.status = STATUS_PROMISE_WAIT;
        thread.ret = '';
        thread.fromPromise = true;
        thread.compatPending = true;
        returnValue.then(value => {
            thread.ret = value;
            thread.status = STATUS_RUNNING;
        }, error => {
            thread.status = STATUS_RUNNING;
            log.warn('Promise rejected in compiled script:', error);
            thread.ret = `${error}`;
            thread.status = STATUS_RUNNING;
        });
        return 2;
    }
    const status = thread.status;
    if (status === STATUS_PROMISE_WAIT || status === STATUS_DONE) {
        // Something external is forcing us to stop
        thread.ret = again ? compatFinish(branchInfo, '') : '';
        return 2;
    }
    if (status === STATUS_YIELD) {
        // Yielded threads will run next iteration.
        thread.status = STATUS_RUNNING;
        return (stuckFn === null || stuckFn()) ? 1 : 3;
    }
    if (status === STATUS_YIELD_TICK) {
        return 1;
    }
    thread.ret = compatFinish(branchInfo, returnValue);
    return 0;
};

/**
 * Get the result of the last compatCall once the thread continues.
 * @param {*} thread thread
 * @param {*} branchInfo branch info or null
 * @returns {*} block result
 */
const compatResume = (thread, branchInfo) => {
    if (thread.compatPending) {
        thread.compatPending = false;
        thread.ret = compatFinish(branchInfo, thread.ret);
    }
    syncLists();
    return thread.ret;
};

/**
 * Start a thread for a broadcast. Same as runtime.startHats('event_whenbroadcastreceived', ...).
 * @param {*} runtime runtime
 * @param {*} name broadcast name
 * @returns {Array<*>} started threads
 */
const broadcast = (runtime, name) => runtime.ttw.broadcast(name);

/**
 * @param {*} variable list variable
 * @returns {TList} list storage
 */
const listOf = variable => variable._tl;

module.exports = {
    RETIRE,
    YIELD,
    SWITCH,
    DONE,
    STATUS_RUNNING,
    STATUS_PROMISE_WAIT,
    STATUS_YIELD,
    STATUS_YIELD_TICK,
    STATUS_DONE,
    makeStuck,
    toNum,
    toBoolean,
    limitPrecision,
    eqSlow,
    gtSlow,
    ltSlow,
    modSlow,
    randomInt,
    randomFloat,
    tan,
    daysSince2000,
    colorToList,
    distance,
    timer,
    retire,
    waitThreads,
    isPromise,
    createBranchInfo,
    compatCall,
    compatResume,
    broadcast,
    listOf,
    syncLists,
    extDirty,
    TList,
    EMPTY_OBJS,
    isNotActuallyZero
};
