// @ts-check


/**
 * @fileoverview TurboTurboWarp backend entry point (spec 01).
 *
 *  - ProgramIR (IR + whole-program analyses) is built once per "epoch" for every original target.
 *  - One JS module per sprite is generated lazily, the first time one of its threads starts.
 *  - Any change that can affect compilation (blocks cache reset, variables created/deleted/renamed,
 *    targets added/removed) starts a new epoch; modules are then rebuilt lazily. Running threads keep
 *    using the old code (as in TW).
 */

const log = require('../util/log');
const {TypeState} = require('../compiler/iroptimizer');
const R = require('./rt/helpers');
const {InputType} = require('../compiler/enums');
const {ProgramIR, regenerateUnitIR} = require('./program');
const {ModuleBuilder, UnitEmitter, promotionCandidates, MAX_FUNCTION_NODES} = require('./emit');
const {countNodes} = require('./ir-walk');
const types = require('./analysis/types');
const {inlineCalls} = require('./analysis/inline');
const sched = require('./sched');

const R_NAMES = [
    'toNum', 'toBoolean', 'limitPrecision', 'eqSlow', 'gtSlow', 'ltSlow', 'modSlow', 'randomInt',
    'randomFloat', 'tan', 'daysSince2000', 'colorToList', 'distance', 'timer', 'retire', 'waitThreads',
    'createBranchInfo', 'compatCall', 'compatResume', 'broadcast', 'broadcastH', 'makeStuck', 'RETIRE'
];

let moduleCounter = 0;

/**
 * @param {string} name sprite name
 * @returns {string} safe JS identifier fragment
 */
const identifierFor = name => String(name).replace(/[^a-zA-Z0-9_]/g, '_')
    .substring(0, 30);

/**
 * A compiled sprite module.
 */
class TTWModule {
    constructor () {
        this.epoch = -1;
        /** @type {Function|null} */
        this.Self = null;
        /** @type {Object.<string, *>} script info by top block id */
        this.scripts = Object.create(null);
        this.source = '';
        /** @type {Error|null} */
        this.error = null;
    }
}

/**
 * Entry type guards of a native unit (02 §4, 04 §2): promoted variables that are read and whose
 * whole-program write type is numeric.
 * @param {ProgramIR} program program
 * @param {import('./program').SpriteIR} sprite sprite
 * @param {import('./program').Unit} unit unit
 * @returns {Array<{key: string, variable: *, noNaN: boolean}>} guards
 */
const guardsFor = (program, sprite, unit) => {
    if (unit.kind !== 'native') return [];
    // Split units don't promote variables, so they have nothing to guard.
    if (countNodes(unit.ir.stack) > MAX_FUNCTION_NODES) return [];
    const guards = [];
    for (const [key, {variable, read}] of promotionCandidates(sprite, unit.ir)) {
        if (!read || !program.isProgramNumber(key)) continue;
        const noNaN = (program.writeTypes.get(key) & InputType.NUMBER_NAN) === 0;
        guards.push({key, variable, noNaN});
    }
    return guards;
};

/**
 * Compile one unit: its fast version and, when it has entry guards, its generic twin.
 * The twin is emitted as source eagerly; V8 compiles functions lazily, so it costs nothing until a guard fails.
 * @param {ModuleBuilder} m module builder
 * @param {ProgramIR} program program
 * @param {import('./program').SpriteIR} sprite sprite
 * @param {import('./program').Unit} unit unit
 * @returns {string} JS
 */
const compileUnit = (m, program, sprite, unit) => {
    const freshIR = callee => {
        const ir = regenerateUnitIR(callee);
        types.seedIRTypes(sprite, callee, ir, sprite.argumentTypes, sprite.returnTypes);
        return ir;
    };
    if (program.runtime.compilerOptions.ttwInline !== false) inlineCalls(unit, unit.ir, freshIR);
    const guards = guardsFor(program, sprite, unit);
    if (guards.length === 0) {
        types.optimizeUnit(sprite, unit.ir, new TypeState());
        return new UnitEmitter(m, unit).compile();
    }
    const twinName = `${m.namesOf(unit).fn}$g`;
    const twinIR = freshIR(unit);
    if (program.runtime.compilerOptions.ttwInline !== false) inlineCalls(unit, twinIR, freshIR);
    types.optimizeUnit(sprite, twinIR, new TypeState());
    const twin = new UnitEmitter(m, unit, {ir: twinIR, name: twinName}).compile();

    const entry = new TypeState();
    for (const guard of guards) {
        entry.setVariableType(guard.variable, guard.noNaN ? InputType.NUMBER : InputType.NUMBER_OR_NAN);
    }
    types.optimizeUnit(sprite, unit.ir, entry);
    const fast = new UnitEmitter(m, unit, {guards, twin: twinName}).compile();
    return fast + twin;
};

/**
 * Generate and instantiate the module of one sprite.
 * @param {*} runtime runtime
 * @param {ProgramIR} program program
 * @param {import('./program').SpriteIR} sprite sprite
 * @returns {TTWModule} module
 */
const compileSprite = (runtime, program, sprite) => {
    const result = new TTWModule();
    const m = new ModuleBuilder(program, sprite, runtime);

    // Callees first (Tarjan order), so a failed callee is known before its callers are emitted.
    const units = sprite.units().slice()
        .sort((a, b) => a.scc - b.scc);
    /** @type {Map<import('./program').Unit, string>} */
    const pieces = new Map();
    for (const unit of units) {
        if (!unit.supported) continue;
        if (unit.calls.some(callee => !callee.supported)) {
            unit.unsupported = true;
            continue;
        }
        try {
            pieces.set(unit, compileUnit(m, program, sprite, unit));
        } catch (e) {
            log.warn(`TTW: cannot compile ${unit.key} of ${sprite.target.getName()}; using the TW backend`, e);
            unit.unsupported = true;
            runtime.ttw.errors.push(e);
        }
    }
    // Units inside a cycle with a failed member: drop until stable.
    let changed = true;
    while (changed) {
        changed = false;
        for (const unit of pieces.keys()) {
            if (unit.calls.some(callee => !callee.supported || !pieces.has(callee))) {
                pieces.delete(unit);
                unit.unsupported = true;
                changed = true;
            }
        }
    }

    let body = '';
    for (const piece of pieces.values()) body += piece;
    let scripts = '';
    let index = 0;
    for (const unit of sprite.scripts.values()) {
        if (!pieces.has(unit)) continue;
        const names = m.namesOf(unit);
        const resumable = unit.kind === 'resumable';
        const native = resumable ? 'null' : names.fn;
        const step = resumable ? names.fn : 'null';
        const frame = resumable ? names.frame : 'null';
        scripts += `${JSON.stringify(unit.topBlockId)}: {index: ${index++}, native: ${native}, step: ${step}, ` +
            `Frame: ${frame}, executableHat: ${!!unit.ir.executableHat}},\n`;
    }

    const name = `ttw$${identifierFor(sprite.target.getName())}_${moduleCounter++}`;
    let src = `(function ${name} (R, G) {\n"use strict";\n`;
    src += `const {${R_NAMES.join(', ')}} = R;\n`;
    src += 'const runtime = G.runtime;\nconst stage = G.stage;\nconst CONTINUE = {};\n';
    src += m.prologue();
    src += body;
    src += `return {Self, scripts: {\n${scripts}}};\n})`;
    result.source = src;

    if (runtime.debug) {
        log.info(`TTW: ${sprite.target.getName()}: compiled module`, src);
    }
    // eslint-disable-next-line no-use-before-define
    if (TTWRuntime.testingApparatus) {
        // eslint-disable-next-line no-use-before-define
        TTWRuntime.testingApparatus.report(sprite.target, src);
    }

    try {
        // eslint-disable-next-line no-new-func
        const factory = new Function(`return ${src}`)();
        const exports = factory(R, {
            runtime,
            stage: runtime.getTargetForStage(),
            broadcastHandle: broadcastName => runtime.ttw.broadcasts.handle(broadcastName)
        });
        result.Self = exports.Self;
        for (const topBlockId of Object.keys(exports.scripts)) {
            const sc = exports.scripts[topBlockId];
            sc.module = result;
            sc.topBlockId = topBlockId;
            result.scripts[topBlockId] = sc;
        }
    } catch (e) {
        log.error('TTW: was unable to instantiate module', src);
        result.error = e;
        result.scripts = Object.create(null);
        runtime.ttw.errors.push(e);
    }
    return result;
};

class TTWRuntime {
    /**
     * @param {*} runtime runtime
     */
    constructor (runtime) {
        this.runtime = runtime;
        this.epoch = 0;
        /** @type {ProgramIR|null} */
        this.program = null;
        /** @type {Error[]} compilation problems that caused a fallback to the TW backend */
        this.errors = [];
        this.broadcasts = new sched.BroadcastTable(runtime);
    }

    /**
     * Start a new epoch: all modules will be regenerated on next use.
     */
    invalidate () {
        this.epoch++;
        this.program = null;
        this.broadcasts.invalidate();
    }

    /**
     * @returns {ProgramIR} program for the current epoch
     */
    getProgram () {
        if (this.program === null) {
            this.program = ProgramIR.build(this.runtime);
        }
        return this.program;
    }

    /**
     * @param {*} target original or clone
     * @returns {TTWModule|null} module of the target's sprite
     */
    getModule (target) {
        const blocks = target.blocks;
        const cached = blocks._cache.ttwModule;
        if (cached && cached.epoch === this.epoch) {
            return cached;
        }
        const program = this.getProgram();
        const sprite = program.sprites.get(blocks);
        if (!sprite) return null;
        let module;
        try {
            module = compileSprite(this.runtime, program, sprite);
        } catch (e) {
            log.warn('TTW: cannot compile sprite; using the TW backend', e);
            this.errors.push(e);
            module = new TTWModule();
            module.error = e;
        }
        module.epoch = this.epoch;
        blocks._cache.ttwModule = module;
        return module;
    }

    /**
     * Try to set up a thread to run with the TTW backend (spec 06 §1).
     * @param {*} thread thread
     * @returns {boolean} true on success
     */
    tryStart (thread) {
        const target = thread.target;
        if (thread.blockContainer !== target.blocks) return false;
        const module = this.getModule(target);
        if (!module) return false;
        const sc = module.scripts[thread.topBlock];
        if (!sc) return false;
        sched.startThread(thread, sc);
        return true;
    }

    /**
     * @param {string} name broadcast name
     * @returns {Array<*>} started threads
     */
    broadcast (name) {
        return this.broadcasts.broadcast(name);
    }
}

TTWRuntime.testingApparatus = null;

module.exports = {
    TTWRuntime,
    TTWModule,
    compileSprite
};
