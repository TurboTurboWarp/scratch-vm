// @ts-check
/* eslint-disable no-self-compare, no-undefined */


/**
 * @fileoverview TTW thread start, step and broadcast table (spec 06).
 */

const R = require('./rt/helpers');
const jsexecute = require('../compiler/jsexecute');

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
 * Broadcast receivers, rebuilt lazily when targets, their execution order or their scripts change (06 §3).
 * Starting threads has exactly the semantics of runtime.startHats('event_whenbroadcastreceived', ...).
 */
class BroadcastTable {
    /**
     * @param {*} runtime runtime
     */
    constructor (runtime) {
        this.runtime = runtime;
        /** @type {Map<string, Array<{target: *, topBlockId: string}>>|null} */
        this.receivers = null;
        this.version = -1;
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
            list.push({target, topBlockId: script.blockId});
        });
        this.receivers = receivers;
        this.version = runtime.ttwExecutableVersion;
    }

    /**
     * @param {*} name broadcast name
     * @returns {Array<*>} started threads
     */
    broadcast (name) {
        const runtime = this.runtime;
        if (this.receivers === null || this.version !== runtime.ttwExecutableVersion) {
            this.build();
        }
        const upper = String(name).toUpperCase();
        const list = this.receivers.get(upper);
        const newThreads = [];
        if (!list) return newThreads;
        const threadMap = runtime.threadMap;
        for (let i = 0; i < list.length; i++) {
            const {target, topBlockId} = list[i];
            // restartExistingThreads
            const existingThread = threadMap.get(`${target.id}&${topBlockId}`);
            if (existingThread) {
                newThreads.push(runtime._restartThread(existingThread));
            } else {
                newThreads.push(runtime._pushThread(topBlockId, target));
            }
        }
        // Same as startHats: threads that aren't compiled run their hat block immediately.
        for (let i = 0; i < newThreads.length; i++) {
            const thread = newThreads[i];
            if (!thread.isCompiled) {
                if (interpreterExecute === null) interpreterExecute = require('../engine/execute');
                interpreterExecute(runtime.sequencer, thread);
                thread.goToNextBlock();
            }
        }
        return newThreads;
    }
}

module.exports = {
    startThread,
    execute,
    BroadcastTable
};
