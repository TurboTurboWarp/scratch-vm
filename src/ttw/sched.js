// @ts-check
/* eslint-disable no-self-compare, no-undefined */


/**
 * @fileoverview TTW thread start, step and broadcast table (spec 06).
 */

const R = require('./rt/helpers');
const jsexecute = require('../compiler/jsexecute');
const Thread = require('../engine/thread');

const StackFrame = Thread._StackFrame;

const {RETIRE, extDirty, syncLists} = R;

/** @type {Function|null} engine/execute.js (required lazily to avoid a require cycle) */
let interpreterExecute = null;

/**
 * Set up a thread to run a TTW script. No per-thread closures are created (06 §1).
 * @param {*} thread thread
 * @param {*} sc script info from a module
 */
const startThread = (thread, sc) => {
    const target = thread.target;
    let self = target._ttwSelf;
    if (self === null || self === undefined || self.constructor !== sc.module.Self) {
        self = new sc.module.Self(target);
        target._ttwSelf = self;
    }
    thread.ttw = sc;
    thread.self = self;
    thread.executableHat = sc.executableHat;
    thread.procedures = null;
    thread.generator = null;
    thread.compiledFunction = null;
    if (sc.step !== null) {
        thread.frame = new sc.Frame(null);
        thread.fn = sc.step;
    }
    thread.isCompiled = true;
};

/**
 * Step a TTW thread (06 §2). Replaces jsexecute.execute for these threads.
 * @param {*} thread thread
 */
const execute = thread => {
    if (extDirty.length !== 0) syncLists();
    const sc = thread.ttw;
    try {
        if (sc.native !== null) {
            sc.native(thread, thread.self);
            R.retire(thread);
            return;
        }
        if (thread.fn === null) return;
        let r = thread.fn(thread, thread.frame);
        while (r === 1) r = thread.fn(thread, thread.frame);
        if (r === 2) R.retire(thread);
    } catch (e) {
        if (e !== RETIRE) throw e;
    }
};

jsexecute.setTTWExecute(execute);

/**
 * Run the hat of threads that aren't compiled (same as the tail of runtime.startHats).
 * @param {*} runtime runtime
 * @param {Array<*>} newThreads started threads
 */
const runInterpretedHats = (runtime, newThreads) => {
    for (let i = 0; i < newThreads.length; i++) {
        const thread = newThreads[i];
        if (!thread.isCompiled) {
            if (interpreterExecute === null) interpreterExecute = require('../engine/execute');
            interpreterExecute(runtime.sequencer, thread);
            thread.goToNextBlock();
        }
    }
};

/**
 * One receiver script of a broadcast.
 */
class Receiver {
    constructor (target, topBlockId) {
        this.target = target;
        this.topBlockId = topBlockId;
        /** Thread.getId() of every thread of this script; a flat string so Map lookups don't rehash. */
        this.key = Thread.getIdFromTargetAndBlock(target, topBlockId);
        /** Script info used the last time this receiver was started with TTW. */
        this.sc = null;
    }
}

const NO_RECEIVERS = [];

/**
 * A broadcast name resolved at module instantiation (06 §3): generated code calls start() and no per-broadcast
 * string work or table lookups remain.
 */
class BroadcastHandle {
    constructor (table, upper) {
        this.table = table;
        this.runtime = table.runtime;
        this.upper = upper;
        this.gen = -1;
        /** @type {Receiver[]} */
        this.list = NO_RECEIVERS;
    }

    /**
     * Same as runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: name}).
     * @returns {Array<*>} started threads
     */
    start () {
        const table = this.table;
        const runtime = this.runtime;
        if (table.receivers === null || table.version !== runtime.ttwExecutableVersion || this.gen !== table.gen) {
            this.list = table.receiversOf(this.upper);
            this.gen = table.gen;
        }
        const list = this.list;
        const n = list.length;
        if (n === 0) return [];
        const threadMap = runtime.threadMap;
        const threads = runtime.threads;
        const ttw = runtime.ttw;
        const options = runtime.compilerOptions;
        const useTTW = options.enabled && options.backend !== 'tw';
        const newThreads = new Array(n);
        let interpreted = false;
        for (let i = 0; i < n; i++) {
            const receiver = list[i];
            const key = receiver.key;
            // restartExistingThreads
            const existingThread = threadMap.get(key);
            if (existingThread !== undefined) {
                const restarted = newThreads[i] = runtime._restartThread(existingThread);
                if (!restarted.isCompiled) interpreted = true;
                continue;
            }
            // runtime._pushThread(topBlockId, target), with the script looked up once per receiver.
            const target = receiver.target;
            const blocks = target.blocks;
            const thread = new Thread(receiver.topBlockId);
            thread.target = target;
            thread.blockContainer = blocks;
            thread._id = key;
            // thread.pushStack() without its out-of-bounds read of the parent frame
            thread.stack.push(receiver.topBlockId);
            thread.stackFrames.push(StackFrame.create(false));
            threads.push(thread);
            threadMap.set(key, thread);
            const sc = receiver.sc;
            if (useTTW && sc !== null && sc.module.epoch === ttw.epoch && blocks._cache.ttwModule === sc.module) {
                thread.triedToCompile = true;
                startThread(thread, sc);
                if (!blocks.forceNoGlow) {
                    thread.blockGlowInFrame = receiver.topBlockId;
                    thread.requestScriptGlowInFrame = true;
                }
            } else {
                if (options.enabled) thread.tryCompile();
                receiver.sc = thread.ttw;
                if (!thread.isCompiled) interpreted = true;
            }
            newThreads[i] = thread;
        }
        if (interpreted) runInterpretedHats(runtime, newThreads);
        return newThreads;
    }
}

/**
 * Broadcast receivers, rebuilt lazily when targets, their execution order or their scripts change (06 §3).
 * Starting threads has exactly the semantics of runtime.startHats('event_whenbroadcastreceived', ...).
 */
class BroadcastTable {
    /**
     * @param {*} runtime runtime
     */
    constructor (runtime) {
        this.runtime = runtime;
        /** @type {Map<string, Receiver[]>|null} */
        this.receivers = null;
        this.version = -1;
        /** Incremented by every build(); handles compare it to know their receiver list is current. */
        this.gen = 0;
        /** @type {Map<string, BroadcastHandle>} */
        this.handles = new Map();
    }

    invalidate () {
        this.receivers = null;
    }

    build () {
        const runtime = this.runtime;
        const receivers = new Map();
        runtime.allScriptsByOpcodeDo('event_whenbroadcastreceived', (script, target) => {
            const field = script.fieldsOfInputs.BROADCAST_OPTION;
            if (!field) return;
            const name = field.value;
            let list = receivers.get(name);
            if (!list) {
                list = [];
                receivers.set(name, list);
            }
            list.push(new Receiver(target, script.blockId));
        });
        this.receivers = receivers;
        this.version = runtime.ttwExecutableVersion;
        this.gen++;
    }

    /**
     * @param {string} upper upper case broadcast name
     * @returns {Receiver[]} current receivers
     */
    receiversOf (upper) {
        if (this.receivers === null || this.version !== this.runtime.ttwExecutableVersion) {
            this.build();
        }
        return this.receivers.get(upper) || NO_RECEIVERS;
    }

    /**
     * @param {*} name broadcast name
     * @returns {BroadcastHandle} handle
     */
    handle (name) {
        const upper = String(name).toUpperCase();
        let handle = this.handles.get(upper);
        if (!handle) {
            handle = new BroadcastHandle(this, upper);
            this.handles.set(upper, handle);
        }
        return handle;
    }

    /**
     * @param {*} name broadcast name
     * @returns {Array<*>} started threads
     */
    broadcast (name) {
        return this.handle(name).start();
    }
}

module.exports = {
    startThread,
    execute,
    BroadcastTable
};
