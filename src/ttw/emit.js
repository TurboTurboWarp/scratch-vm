// @ts-check


/**
 * @fileoverview TurboTurboWarp code generation (spec 04, 05, 07).
 *
 * One module per sprite. Each unit (hat script or procedure variant) becomes either:
 *  - a native function (it never yields): `function fp_k(th, S, p0, ...)`; scalar variables are promoted to JS
 *    locals, flushed to their home `Variable.value` at exits and around calls; procedures are called directly.
 *  - a resumable step function (it may yield): `function rp_k(th, fr)` that runs `for (;;) switch (fr.pc)`
 *    and returns YIELD(0) / SWITCH(1) / DONE(2). No generators are used.
 *
 * Expression generation is a port of TW's jsgen.descendInput; comparisons keep TW's type rules verbatim.
 */

const log = require('../util/log');
const BlockType = require('../extension-support/block-type');
const {StackOpcode, InputOpcode, InputType} = require('../compiler/enums');
const {IntermediateInput, IntermediateStack} = require('../compiler/intermediate');
const {forEachChild, walkInput, walkStack, countNodes, LOOP_OPCODES} = require('./ir-walk');

/* eslint-disable max-len */
/* eslint-disable no-negated-condition */
/* eslint-disable no-self-compare */
/* eslint-disable prefer-template */

const sanitize = string => {
    if (typeof string !== 'string') {
        string = '' + string;
    }
    return JSON.stringify(string).slice(1, -1);
};

const str = s => `"${sanitize(s)}"`;

const PEN_EXT = 'runtime.ext_pen';
const PEN_STATE = `${PEN_EXT}._getPenState(target)`;

const SLOT_OPCODE = 'ttw.slot';
const RAW_OPCODE = 'ttw.raw';

const MAX_SAFE_MOD = 4503599627370496; // 2^52: q - floor(q / m) * m is exact below this

/** Native units larger than this (IR nodes) are split into part functions (07 §4). */
const MAX_FUNCTION_NODES = 3000;
/** Target size of a part function. */
const PART_NODES = 1500;

/** Iterations of a chunked loop per call of its chunk function (07 §5). */
const CHUNK_ITERATIONS = 4096;

/** A JS expression that can be repeated freely (no side effects, cheap). */
const SIMPLE_EXPRESSION = /^(?:[A-Za-z_$][\w$]*|fr\.s\d+|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|"(?:[^"\\]|\\.)*"|true|false|-0)$/;

const isSafeInputForEqualsOptimization = (input, other) => {
    // Only optimize constants
    if (input.opcode !== InputOpcode.CONSTANT) return false;
    // Only optimize when the constant can always be thought of as a number
    if (input.isAlwaysType(InputType.NUMBER) || input.isAlwaysType(InputType.STRING_NUM)) {
        if (other.isSometimesType(InputType.NUMBER_NAN | InputType.STRING_NAN | InputType.BOOLEAN_INTERPRETABLE)) {
            // Never optimize 0 if the other input can be NaN, '' or a boolean.
            return (+input.inputs.value) !== 0;
        }
        return true;
    }
    return false;
};

/**
 * @param {IntermediateInput} input input
 * @returns {string|null} lowercased constant string that a number can never equal (04 §6), or null
 */
const nonNumericStringConstant = input => {
    if (input.opcode !== InputOpcode.CONSTANT) return null;
    if (typeof input.inputs.value !== 'string') return null;
    const s = input.inputs.value;
    const n = +s;
    if (n === n && !(n === 0 && /^[^0-9\t]*$/.test(s))) return null;
    const lower = s.toLowerCase();
    if (lower === 'nan' || lower === 'infinity' || lower === '-infinity') return null;
    return lower;
};

/** @type {Map<string, string[]>|null} ASCII character -> every UTF-16 code unit that lower-cases to it */
let asciiLowerSources = null;

/**
 * @param {string} c one ASCII character (already lower case)
 * @returns {string[]} all one code unit strings s with s.toLowerCase() === c
 */
const lowerSourcesOf = c => {
    if (asciiLowerSources === null) {
        asciiLowerSources = new Map();
        for (let u = 0; u < 65536; u++) {
            const source = String.fromCharCode(u);
            const lower = source.toLowerCase();
            if (lower.length === 1 && lower.charCodeAt(0) < 128) {
                const list = asciiLowerSources.get(lower);
                if (list) list.push(source);
                else asciiLowerSources.set(lower, [source]);
            }
        }
    }
    return asciiLowerSources.get(c) || [];
};

/**
 * Case insensitive equality of a string with a constant, as Scratch's string comparison does it
 * (`s.toLowerCase() === constant.toLowerCase()`), without calling toLowerCase where it can't matter.
 * Lower-casing never shortens a string and no character lower-cases to more than one ASCII character,
 * so a string can only match an ASCII constant of the same length; for a single ASCII character the
 * few strings that match are known exactly.
 * @param {string} s simple JS expression (evaluated several times) that is a string
 * @param {string} value the constant
 * @returns {string} JS condition
 */
const equalsIgnoreCase = (s, value) => {
    const lower = value.toLowerCase();
    if (lower === '') return `${s}.length === 0`;
    // eslint-disable-next-line no-control-regex
    const ascii = /^[\x00-\x7f]*$/.test(lower);
    if (ascii && lower.length === 1) {
        const sources = lowerSourcesOf(lower);
        if (sources.length > 0 && sources.length <= 4) {
            return `(${sources.map(source => `${s} === ${str(source)}`).join(' || ')})`;
        }
    }
    const exact = lower === value ? '' : `${s} === ${str(value)} || `;
    const general = `(${exact}${s} === ${str(lower)} || ${s}.toLowerCase() === ${str(lower)})`;
    return ascii ? `(${s}.length === ${lower.length} && ${general})` : general;
};

/**
 * @param {IntermediateInput} a input
 * @param {IntermediateInput} b input
 * @returns {boolean} true if both read the same variable or argument or are the same number constant,
 * possibly through the same number cast (so they evaluate to the same value)
 */
const sameSimpleInput = (a, b) => {
    if (a.opcode !== b.opcode) return false;
    switch (a.opcode) {
    case InputOpcode.CAST_NUMBER:
        return sameSimpleInput(a.inputs.target, b.inputs.target);
    case InputOpcode.VAR_GET:
        return a.inputs.variable.id === b.inputs.variable.id && a.inputs.variable.scope === b.inputs.variable.scope;
    case InputOpcode.PROCEDURE_ARGUMENT:
        return a.inputs.index === b.inputs.index;
    case RAW_OPCODE:
        return a.inputs.js === b.inputs.js;
    case InputOpcode.CONSTANT:
        return typeof a.inputs.value === 'number' && Object.is(a.inputs.value, b.inputs.value);
    default:
        return false;
    }
};

/**
 * @param {string} js operand (already evaluated once)
 * @param {IntermediateInput} input operand IR
 * @returns {string} JS condition that the operand is a number ("" if statically known)
 */
const typeGuard = (js, input) => (input.isAlwaysType(InputType.NUMBER_OR_NAN) ? '' : `typeof ${js} === "number"`);

/**
 * @param {string} js operand (already evaluated once)
 * @param {IntermediateInput} input operand IR
 * @returns {string} JS condition that the operand is not NaN ("" if statically known)
 */
const nanGuard = (js, input) => (input.isAlwaysType(InputType.NUMBER) ? '' : `${js} === ${js}`);

/**
 * @param {string[]} guards conditions
 * @returns {string} conjunction ("true" if empty)
 */
const joinGuards = guards => {
    const g = guards.filter(Boolean);
    return g.length ? `(${g.join(' && ')})` : 'true';
};

/**
 * Promotion rule (04 §1): a scalar variable becomes a JS local in a native unit if it is used in a loop
 * or used at least twice. Cloud variables are never promoted.
 * @param {import('./program').SpriteIR} sprite sprite
 * @param {*} ir unit IR
 * @returns {Map<string, {variable: *, read: boolean}>} promoted variables
 */
const promotionCandidates = (sprite, ir) => {
    const uses = new Map();
    const note = (variable, depth, read) => {
        const key = sprite.varKey(variable);
        let u = uses.get(key);
        if (!u) {
            u = {variable, count: 0, inLoop: false, read: false};
            uses.set(key, u);
        }
        u.count++;
        if (depth > 0) u.inLoop = true;
        if (read) u.read = true;
    };
    walkStack(ir.stack, {
        block: (block, depth) => {
            if (block.opcode === StackOpcode.VAR_SET || block.opcode === StackOpcode.CONTROL_FOR) {
                note(block.inputs.variable, LOOP_OPCODES.has(block.opcode) ? depth + 1 : depth, false);
            }
        },
        input: (input, depth) => {
            if (input.opcode === InputOpcode.VAR_GET) note(input.inputs.variable, depth, true);
        }
    });
    const result = new Map();
    for (const [key, u] of uses) {
        if (u.variable.isCloud) continue;
        if (u.inLoop || u.count >= 2) result.set(key, {variable: u.variable, read: u.read});
    }
    return result;
};

/**
 * Per-module state shared by all unit emitters.
 */
class ModuleBuilder {
    /**
     * @param {import('./program').ProgramIR} program program
     * @param {import('./program').SpriteIR} sprite sprite
     * @param {*} runtime runtime
     */
    constructor (program, sprite, runtime) {
        this.program = program;
        this.sprite = sprite;
        this.runtime = runtime;
        this.target = sprite.target;
        this.isStage = sprite.isStage;
        /** @type {Map<string, string>} stage variable id -> module const */
        this.stageVars = new Map();
        /** @type {Map<string, string>} stage list id -> module const */
        this.stageLists = new Map();
        /** @type {Map<string, string>} sprite variable id -> Self field */
        this.selfVars = new Map();
        /** @type {Map<string, string>} sprite list id -> Self field */
        this.selfLists = new Map();
        /** @type {Map<string, string>} opcode -> module const */
        this.opcodeFunctions = new Map();
        /** @type {Map<string, string>} constant broadcast name -> module const holding its handle */
        this.broadcastHandles = new Map();
        /** @type {Map<import('./program').Unit, {fn: string, frame: string|null}>} */
        this.unitNames = new Map();
        this.counter = 0;
        const sampler = runtime.sampler;
        this.sampler = sampler && sampler.enableCommands ? sampler : null;
        this.debug = runtime.debug;
    }

    /**
     * @param {import('./program').Unit} unit unit
     * @returns {{fn: string, frame: string|null}} names
     */
    namesOf (unit) {
        let names = this.unitNames.get(unit);
        if (!names) {
            const k = this.counter++;
            const prefix = unit.isProcedure ? 'p' : 's';
            if (unit.kind === 'resumable') {
                names = {fn: `r${prefix}_${k}`, frame: `F${prefix}_${k}`};
            } else {
                names = {fn: `f${prefix}_${k}`, frame: null};
            }
            this.unitNames.set(unit, names);
        }
        return names;
    }

    /**
     * @param {*} variable variable descriptor
     * @returns {string} JS expression of the Variable object
     */
    variableHome (variable) {
        if (this.isStage || variable.scope === 'stage') {
            let name = this.stageVars.get(variable.id);
            if (!name) {
                name = `g${this.stageVars.size}`;
                this.stageVars.set(variable.id, name);
            }
            return name;
        }
        let name = this.selfVars.get(variable.id);
        if (!name) {
            name = `v${this.selfVars.size}`;
            this.selfVars.set(variable.id, name);
        }
        return `S.${name}`;
    }

    /**
     * @param {*} list list descriptor
     * @returns {string} JS expression of the TList
     */
    listHome (list) {
        if (this.isStage || list.scope === 'stage') {
            let name = this.stageLists.get(list.id);
            if (!name) {
                name = `gl${this.stageLists.size}`;
                this.stageLists.set(list.id, name);
            }
            return name;
        }
        let name = this.selfLists.get(list.id);
        if (!name) {
            name = `l${this.selfLists.size}`;
            this.selfLists.set(list.id, name);
        }
        return `S.${name}`;
    }

    /**
     * @param {string} opcode block opcode
     * @returns {string} module const holding the primitive
     */
    opcodeFunction (opcode) {
        let name = this.opcodeFunctions.get(opcode);
        if (!name) {
            name = `o${this.opcodeFunctions.size}`;
            this.opcodeFunctions.set(opcode, name);
        }
        return name;
    }

    /**
     * @param {*} input broadcast name input
     * @returns {string|null} module const holding the broadcast handle, or null if the name is not constant
     */
    broadcastHandle (input) {
        if (input.opcode !== InputOpcode.CONSTANT) return null;
        const upper = String(input.inputs.value).toUpperCase();
        let name = this.broadcastHandles.get(upper);
        if (!name) {
            name = `bc${this.broadcastHandles.size}`;
            this.broadcastHandles.set(upper, name);
        }
        return name;
    }

    /**
     * @returns {string} module prologue
     */
    prologue () {
        let src = '';
        for (const [id, name] of this.stageVars) {
            src += `const ${name} = stage.variables[${str(id)}];\n`;
        }
        for (const [id, name] of this.stageLists) {
            src += `const ${name} = stage.variables[${str(id)}]._tl;\n`;
        }
        for (const [opcode, name] of this.opcodeFunctions) {
            src += `const ${name} = runtime.getOpcodeFunction(${str(opcode)});\n`;
        }
        for (const [upper, name] of this.broadcastHandles) {
            src += `const ${name} = G.broadcastHandle(${str(upper)});\n`;
        }
        if (this.sampler) {
            src += 'const pc = runtime.sampler.pc;\n';
        }
        src += 'class Self {\nconstructor (target) {\nthis.target = target;\n';
        for (const [id, name] of this.selfVars) {
            src += `this.${name} = target.variables[${str(id)}];\n`;
        }
        for (const [id, name] of this.selfLists) {
            src += `this.${name} = target.variables[${str(id)}]._tl;\n`;
        }
        src += '}\n}\n';
        return src;
    }
}

/**
 * Information about a substack being compiled (TW's Frame).
 */
class Frame {
    /**
     * @param {boolean} isLoop whether this stack is a loop body
     * @param {number} head resumable: label of the loop head
     */
    constructor (isLoop, head = -1) {
        this.isLoop = isLoop;
        this.isLastBlock = false;
        this.head = head;
    }
}

class UnitEmitter {
    /**
     * @param {ModuleBuilder} m module builder
     * @param {import('./program').Unit} unit unit
     * @param {object} [options] options
     * @param {*} [options.ir] IR to compile instead of unit.ir (generic twin)
     * @param {string} [options.name] function name override (generic twin)
     * @param {Array<{key: string, noNaN: boolean}>} [options.guards] entry type guards (04 §2)
     * @param {string} [options.twin] name of the generic twin to call when a guard fails
     */
    constructor (m, unit, options = {}) {
        this.m = m;
        this.unit = unit;
        this.sprite = unit.sprite;
        this.script = options.ir || unit.ir;
        this.fnName = options.name || m.namesOf(unit).fn;
        this.guards = options.guards || [];
        this.twin = options.twin || null;
        this.resumable = unit.kind === 'resumable';
        this.isWarp = this.script.isWarp;
        this.isProcedure = this.script.isProcedure;
        this.warpTimer = this.script.warpTimer;
        this.target = m.target;

        this.src = '';
        this.nTemps = 0;
        this.aTemps = 0;
        this.labels = 1;
        this.slots = this.script.arguments.length;

        /** @type {Map<string, {home: string, h: string, v: string|null, variable: *, written: boolean}>} */
        this.vars = new Map();
        /** @type {Map<string, string>} list key -> local const */
        this.lists = new Map();
        /** @type {Map<string, string>} list home -> local const */
        this.listLocals = new Map();
        /** @type {Set<string>} lists mutated by fast paths (native: upToDate cleared at exits) */
        this.mutatedLists = new Set();

        /** @type {Frame[]} */
        this.frames = [];
        this.isInHat = false;
        this.descendedIntoModulo = false;
        this.currentSamplerLocation = -1;

        /** @type {WeakMap<object, boolean>} */
        this.yieldCache = new WeakMap();
        /** @type {string|null} */
        this.stuckName = null;
        /** @type {Set<string>} additional locals (inlined procedure arguments) */
        this.extraLocals = new Set();
        /** @type {Set<string>} inlined argument temporaries that hold the argument already cast to a number */
        this.numericRaw = new Set();
        /** @type {Set<string>} locals of variables promoted inside resumable loops */
        this.scopedLocals = new Set();
        /** @type {Array<*>} variables currently promoted inside a resumable loop */
        this.scopedVars = [];
        /** @type {Array<{name: string, body: string}>} loop helper functions of a resumable unit */
        this.loopHelpers = [];
        /** @type {string|null} numeric temp holding the iteration budget of the loop helper being emitted */
        this.helperBudget = null;

        /**
         * Chunk functions (07 §5): top-level loops of native units run in their own function, at most
         * CHUNK_ITERATIONS iterations per call, so V8 optimizes them through normal calls instead of OSR.
         * @type {Array<{name: string, body: string}>}
         */
        this.chunks = [];
        /** Box (a local holding the chunk's state object) while emitting a chunk function, else null. */
        this.chunkBox = null;
        /** True while the next loop emitted is the outer loop of a chunk function. */
        this.chunkTop = false;
        /** Depth of descendStack nesting. */
        this.stackDepth = 0;
        this.chunkLoops = !this.resumable && m.runtime.compilerOptions.ttwChunkLoops !== false;

        /**
         * PURE versioning (04 §5): while emitting the PURE version of a loop, the locals of the lists
         * known to contain only numbers.
         * @type {Set<string>|null}
         */
        this.pureLists = null;
        /** True while emitting the general version of a versioned loop (no nested versioning). */
        this.inGeneralVersion = false;
        /** IR nodes still allowed to be duplicated by versioning in this unit. */
        this.versioningBudget = 1500;
        /**
         * Inside the "in range" version of a counted loop: the induction variable and the lists whose
         * items at that index are known to exist (see rangePlan).
         * @type {{key: string, v: string, lists: Set<string>}|null}
         */
        this.inRange = null;

        /**
         * Numeric view sharing (04 §4), native units: variable key -> numeric temp holding toNumber(variable),
         * valid until the variable is assigned.
         * @type {Map<string, string>}
         */
        this.castCache = new Map();

        /**
         * Function splitting (07 §4): native units above MAX_FUNCTION_NODES are split at top-level statement
         * boundaries into part functions. Variables are not promoted in split units (nothing to flush).
         */
        this.split = !this.resumable && countNodes(this.script.stack) > MAX_FUNCTION_NODES;
        /** @type {string[]} part function sources */
        this.parts = [];
        if (!this.resumable) {
            this.planPromotion();
        }
    }

    // ------------------------------------------------------------------ naming helpers

    numTemp () {
        return `n${this.nTemps++}`;
    }

    /**
     * @returns {string} name of this unit's stuck check (TW has one counter per compiled script)
     */
    stuckFn () {
        if (this.stuckName === null) {
            this.stuckName = `stk${this.m.counter++}`;
        }
        return this.stuckName;
    }

    anyTemp () {
        return `a${this.aTemps++}`;
    }

    slot () {
        return `fr.s${this.slots++}`;
    }

    label () {
        return this.labels++;
    }

    /**
     * Evaluate js once. Returns [prefix, name]: prefix must be evaluated before name is used.
     * @param {string} js expression
     * @param {boolean} numeric whether the value is a number
     * @returns {[string, string]} assignment prefix ("" if not needed) and the name to use
     */
    once (js, numeric) {
        if (SIMPLE_EXPRESSION.test(js)) return ['', js];
        const t = numeric ? this.numTemp() : this.anyTemp();
        return [`${t} = ${js}, `, t];
    }

    // ------------------------------------------------------------------ variables

    /**
     * Native units: decide which scalar variables become JS locals (04 §1).
     */
    planPromotion () {
        walkStack(this.script.stack, {
            block: block => {
                if (block.opcode === StackOpcode.LIST_ADD || block.opcode === StackOpcode.LIST_REPLACE) {
                    // Fast-path stores don't touch upToDate; every exit clears it (planned before emitting exits).
                    this.mutatedLists.add(this.listRef(block.inputs.list));
                }
                if (block.opcode === StackOpcode.VAR_SET || block.opcode === StackOpcode.CONTROL_FOR) {
                    this.varInfo(block.inputs.variable).written = true;
                }
            },
            input: input => {
                if (input.opcode === InputOpcode.VAR_GET) this.varInfo(input.inputs.variable);
            }
        });
        if (this.split) return;
        const promoted = promotionCandidates(this.sprite, this.script);
        for (const [key, info] of this.vars) {
            if (promoted.has(key)) {
                info.v = `v${info.h.substring(1)}`;
            }
        }
    }

    /**
     * @param {*} variable variable descriptor
     * @returns {{home: string, h: string, v: string|null, variable: *, written: boolean}} info
     */
    varInfo (variable) {
        const key = this.sprite.varKey(variable);
        let info = this.vars.get(key);
        if (!info) {
            info = {
                home: this.m.variableHome(variable),
                h: `h${this.vars.size}`,
                v: null,
                variable,
                written: false
            };
            this.vars.set(key, info);
        }
        return info;
    }

    /**
     * @param {*} variable variable descriptor
     * @returns {string} JS expression reading the variable
     */
    readVariable (variable) {
        const info = this.varInfo(variable);
        return info.v ? info.v : `${info.h}.value`;
    }

    /**
     * @param {*} variable variable descriptor
     * @param {string} valueJS value
     * @returns {string} JS statement(s)
     */
    writeVariable (variable, valueJS) {
        const info = this.varInfo(variable);
        if (info.v) {
            info.written = true;
            return `${info.v} = ${valueJS};\n`;
        }
        let src = `${info.h}.value = ${valueJS};\n`;
        if (variable.isCloud) {
            src += `runtime.ioDevices.cloud.requestUpdateVariable(${str(variable.name)}, ${info.h}.value);\n`;
        }
        return src;
    }

    /**
     * @param {Set<string>|null} keys only flush these variables (null = all)
     * @returns {string[]} flush assignments
     */
    flushList (keys) {
        const out = [];
        for (const [key, info] of this.vars) {
            if (info.v && info.written && (keys === null || keys.has(key))) {
                out.push(`${info.h}.value = ${info.v}`);
            }
        }
        return out;
    }

    /**
     * @returns {string[]} statements marking modified lists as changed for monitors
     */
    listExitList () {
        const out = [];
        for (const L of this.mutatedLists) out.push(`${L}.upToDate = false`);
        return out;
    }

    /**
     * @returns {string} statements to run before leaving the function (04 §3)
     */
    exitFlush () {
        const parts = [...this.flushList(null), ...this.listExitList()];
        return parts.length ? parts.join(';\n') + ';\n' : '';
    }

    /**
     * @returns {string} comma-expression prefix that flushes everything (for flush-all points)
     */
    flushAllExpressionPrefix () {
        const parts = this.flushList(null);
        return parts.length ? parts.join(', ') + ', ' : '';
    }

    /**
     * @param {*} list list descriptor
     * @returns {string} local const for the TList
     */
    listRef (list) {
        const home = this.m.listHome(list);
        let local = this.listLocals.get(home);
        if (!local) {
            local = `L${this.listLocals.size}`;
            this.listLocals.set(home, local);
        }
        return local;
    }

    /**
     * Record that a list was modified by a fast path.
     * @param {string} L list local
     * @returns {string} statement for resumable units ("" for native units, which clear at exit)
     */
    markListChanged (L) {
        if (this.resumable) return `${L}.upToDate = false;\n`;
        this.mutatedLists.add(L);
        return '';
    }

    // ------------------------------------------------------------------ yield analysis

    /**
     * @param {string} variant procedure variant
     * @returns {import('./program').Unit|null} callee
     */
    calleeOf (variant) {
        return this.sprite.procedures.get(variant) || null;
    }

    /**
     * @param {*} node procedure call node inputs
     * @returns {boolean} true if this call does nothing (empty procedure)
     */
    isEmptyCall (node) {
        const callee = this.calleeOf(node.variant);
        return !callee || !callee.ir || callee.ir.stack === null;
    }

    /**
     * @param {IntermediateInput} input input
     * @returns {boolean} true if evaluating the input may yield
     */
    inputYields (input) {
        switch (input.opcode) {
        case InputOpcode.COMPATIBILITY_LAYER:
        case InputOpcode.ADDON_CALL:
        case InputOpcode.OLD_COMPILER_COMPATIBILITY_LAYER:
            return true;
        case InputOpcode.PROCEDURE_CALL: {
            const node = input.inputs;
            if (this.isEmptyCall(node)) return false;
            const callee = this.calleeOf(node.variant);
            if (callee.kind === 'resumable') return true;
            if (!this.isWarp && node.code === this.script.procedureCode) return true;
            if (this.isInHat) return true;
            break;
        }
        }
        let yields = false;
        forEachChild(input.inputs, child => {
            if (!yields && this.inputYields(child)) yields = true;
        });
        return yields;
    }

    /**
     * @param {*} block stack block
     * @returns {boolean} true if the block (or anything inside it) may yield
     */
    blockYields (block) {
        const cached = this.yieldCache.get(block);
        if (typeof cached === 'boolean') return cached;
        let yields = !!block.yields;
        switch (block.opcode) {
        case StackOpcode.COMPATIBILITY_LAYER:
        case StackOpcode.ADDON_CALL:
        case StackOpcode.CONTROL_WAIT:
        case StackOpcode.CONTROL_WAIT_UNTIL:
        case StackOpcode.EVENT_BROADCAST_AND_WAIT:
        case StackOpcode.HAT_EDGE:
        case StackOpcode.HAT_PREDICATE:
            yields = true;
            break;
        case StackOpcode.PROCEDURE_CALL: {
            const node = block.inputs;
            if (!this.isEmptyCall(node)) {
                const callee = this.calleeOf(node.variant);
                if (callee.kind === 'resumable') yields = true;
                if (!this.isWarp && node.code === this.script.procedureCode) yields = true;
            }
            break;
        }
        }
        if (!yields) {
            forEachChild(block.inputs, child => {
                if (!yields && this.inputYields(child)) yields = true;
            }, stack => {
                if (!yields && this.stackYields(stack)) yields = true;
            });
        }
        this.yieldCache.set(block, yields);
        return yields;
    }

    /**
     * @param {IntermediateStack|null} stack stack
     * @returns {boolean} true if any block may yield
     */
    stackYields (stack) {
        if (!stack) return false;
        for (const block of stack.blocks) {
            if (this.blockYields(block)) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ expressions

    /**
     * @param {IntermediateInput} input input
     * @returns {boolean} true if the input never needs to be captured before a yield
     */
    isStableInput (input) {
        return input.opcode === InputOpcode.CONSTANT || input.opcode === SLOT_OPCODE ||
            (input.opcode === InputOpcode.PROCEDURE_ARGUMENT && this.resumable);
    }

    /**
     * Resumable: make a slot-backed input holding an already evaluated value.
     * @param {string} slotName slot
     * @param {number} type type
     * @returns {IntermediateInput} input
     */
    slotInput (slotName, type) {
        return new IntermediateInput(SLOT_OPCODE, type, {slot: slotName});
    }

    /**
     * Resumable: evaluate the yielding parts of an input in their own states (spec 05 §2), preserving
     * left-to-right evaluation order. Returns an input that no longer yields.
     * @param {IntermediateInput} input input
     * @returns {IntermediateInput} non-yielding input
     */
    spill (input) {
        if (!this.inputYields(input)) return input;
        const node = input.inputs;
        switch (input.opcode) {
        case InputOpcode.COMPATIBILITY_LAYER: {
            this.spillChildren(node);
            const s = this.slot();
            this.emitCompatibilityLayerCall(node, false, null, s);
            return this.slotInput(s, input.type);
        }
        case InputOpcode.ADDON_CALL: {
            this.spillChildren(node);
            const s = this.slot();
            this.emitAddonCall(node, s);
            return this.slotInput(s, input.type);
        }
        case InputOpcode.PROCEDURE_CALL: {
            const callee = this.calleeOf(node.variant);
            const yieldForRecursion = !this.isWarp && node.code === this.script.procedureCode;
            const yieldForHat = this.isInHat;
            if (yieldForRecursion || yieldForHat || callee.kind === 'resumable') {
                // Arguments are evaluated before the yield (TW yieldThenCall).
                const args = this.captureAll(node.arguments);
                if (yieldForRecursion || yieldForHat) {
                    const y = this.label();
                    this.src += `fr.pc = ${y}; return 0;\ncase ${y}:\n`;
                }
                const s = this.slot();
                if (callee.kind === 'resumable') {
                    this.emitResumableCall(callee, args);
                    this.src += `${s} = th.ret;\n`;
                } else {
                    this.src += `${s} = ${this.nativeCallExpression(callee, args)};\n`;
                }
                return this.slotInput(s, input.type);
            }
            this.spillChildren(node);
            return input;
        }
        default:
            this.spillChildren(node);
            return input;
        }
    }

    /**
     * @param {object} inputs node.inputs
     */
    spillChildren (inputs) {
        const children = [];
        forEachChild(inputs, (child, set) => {
            children.push({child, set});
        });
        let last = -1;
        for (let i = 0; i < children.length; i++) {
            if (this.inputYields(children[i].child)) last = i;
        }
        for (let i = 0; i < last; i++) {
            const {child, set} = children[i];
            const spilled = this.spill(child);
            if (this.isStableInput(spilled)) {
                set(spilled);
            } else {
                const s = this.slot();
                this.src += `${s} = ${this.descendInput(spilled)};\n`;
                set(this.slotInput(s, spilled.type));
            }
        }
        if (last >= 0) {
            children[last].set(this.spill(children[last].child));
        }
    }

    /**
     * Resumable: evaluate every argument into a slot (or keep stable ones), in order.
     * @param {IntermediateInput[]} args arguments
     * @returns {string[]} JS expressions of the evaluated arguments
     */
    captureAll (args) {
        const out = [];
        for (const arg of args) {
            const spilled = this.spill(arg);
            if (this.isStableInput(spilled)) {
                out.push(this.descendInput(spilled));
            } else {
                const s = this.slot();
                this.src += `${s} = ${this.descendInput(spilled)};\n`;
                out.push(s);
            }
        }
        return out;
    }

    /**
     * @param {import('./program').Unit} callee native callee
     * @param {string[]} argsJS arguments
     * @returns {string} call expression (flushing/reloading promoted variables as needed)
     */
    nativeCallExpression (callee, argsJS) {
        const fn = this.m.namesOf(callee).fn;
        const call = `${fn}(th, S${argsJS.map(a => `, ${a}`).join('')})`;
        if (this.resumable && this.scopedVars.length === 0) return call;
        const flushKeys = callee.mayRetire ? null : new Set([...callee.ref, ...callee.mod]);
        const pre = this.flushList(flushKeys);
        const post = [];
        for (const [key, info] of this.vars) {
            if (info.v && callee.mod.has(key)) {
                post.push(`${info.v} = ${info.h}.value`);
            }
        }
        if (callee.mayRetire) {
            pre.push(...this.listExitList());
        }
        if (pre.length === 0 && post.length === 0) return call;
        if (post.length === 0) return `(${pre.join(', ')}, ${call})`;
        const t = this.anyTemp();
        return `(${pre.map(p => `${p}, `).join('')}${t} = ${call}, ${post.join(', ')}, ${t})`;
    }

    /**
     * @param {IntermediateInput} block input node
     * @returns {string} JS expression
     */
    descendInput (block) {
        const node = block.inputs;
        switch (block.opcode) {
        case SLOT_OPCODE:
            return node.slot;
        case RAW_OPCODE:
            return node.js;

        case InputOpcode.NOP:
            return `""`;

        case InputOpcode.PROCEDURE_ARGUMENT:
            return this.resumable ? `fr.s${node.index}` : `p${node.index}`;

        case InputOpcode.ADDON_CALL:
        case InputOpcode.COMPATIBILITY_LAYER:
        case InputOpcode.OLD_COMPILER_COMPATIBILITY_LAYER:
            throw new Error(`TTW: unexpected yielding input ${block.opcode}`);

        case InputOpcode.CAST_BOOLEAN:
            return `toBoolean(${this.descendInput(node.target)})`;
        case InputOpcode.CAST_NUMBER: {
            const target = node.target;
            if (target.isAlwaysType(InputType.BOOLEAN)) {
                return `(+${this.descendInput(target)})`;
            }
            if (target.opcode === InputOpcode.LIST_GET) {
                return this.listGetNumber(target.inputs);
            }
            if (target.opcode === RAW_OPCODE && this.numericRaw.has(target.inputs.js)) {
                // An inlined argument that was converted when it was bound.
                return target.inputs.js;
            }
            if (
                target.opcode === InputOpcode.OP_MULTIPLY &&
                target.inputs.left.isAlwaysType(InputType.NUMBER) &&
                sameSimpleInput(target.inputs.left, target.inputs.right)
            ) {
                // x * x is never NaN when x isn't (only 0 * Infinity is).
                return this.descendInput(target);
            }
            if (target.opcode === InputOpcode.VAR_GET && !this.resumable) {
                const cached = this.castCache.get(this.sprite.varKey(target.inputs.variable));
                if (cached) return cached;
            }
            if (target.isAlwaysType(InputType.NUMBER_OR_NAN) && !target.isSometimesType(InputType.NUMBER_NEG_ZERO)) {
                // A number that can't be -0: `x || 0` maps exactly NaN (and 0) to 0.
                return `(${this.descendInput(target)} || 0)`;
            }
            const t = this.numTemp();
            if (target.isAlwaysType(InputType.NUMBER_OR_NAN)) {
                return `((${t} = ${this.descendInput(target)}) === ${t} ? ${t} : 0)`;
            }
            return `((${t} = +${this.descendInput(target)}) === ${t} ? ${t} : 0)`;
        }
        case InputOpcode.CAST_NUMBER_OR_NAN:
            return `(+${this.descendInput(node.target)})`;
        case InputOpcode.CAST_NUMBER_INDEX:
            return `(${this.descendInput(node.target.toType(InputType.NUMBER_OR_NAN))} | 0)`;
        case InputOpcode.CAST_STRING:
            return `("" + ${this.descendInput(node.target)})`;
        case InputOpcode.CAST_COLOR:
            return `colorToList(${this.descendInput(node.target)})`;

        case InputOpcode.CONSTANT:
            if (block.isAlwaysType(InputType.NUMBER)) {
                if (typeof node.value !== 'number') throw new Error(`JS: '${block.type}' type constant had ${typeof node.value} type value. Expected number.`);
                if (Object.is(node.value, -0)) return '-0';
                return node.value.toString();
            } else if (block.isAlwaysType(InputType.BOOLEAN)) {
                if (typeof node.value !== 'boolean') throw new Error(`JS: '${block.type}' type constant had ${typeof node.value} type value. Expected boolean.`);
                return node.value.toString();
            } else if (block.isAlwaysType(InputType.COLOR)) {
                if (!Array.isArray(node.value)) throw new Error(`JS: '${block.type}' type constant was not an array.`);
                if (node.value.length !== 3) throw new Error(`JS: '${block.type}' type constant had an array of length '${node.value.length}'. Expected 3.`);
                for (let i = 0; i < 3; i++) {
                    if (typeof node.value[i] !== 'number') {
                        throw new Error(`JS: '${block.type}' type constant element ${i} had a value of type '${node.value[i]}'. Expected number.`);
                    }
                }
                return `[${node.value[0]},${node.value[1]},${node.value[2]}]`;
            } else if (block.isSometimesType(InputType.STRING)) {
                return str(node.value.toString());
            } throw new Error(`JS: Unknown constant input type '${block.type}'.`);

        case InputOpcode.SENSING_KEY_DOWN:
            return `runtime.ioDevices.keyboard.getKeyIsDown(${this.descendInput(node.key)})`;

        case InputOpcode.LIST_CONTAINS:
            return `${this.listRef(node.list)}.contains(${this.descendInput(node.item)})`;
        case InputOpcode.LIST_CONTENTS:
            return `${this.listRef(node.list)}.contents()`;
        case InputOpcode.LIST_GET:
            return this.listGetAny(node);
        case InputOpcode.LIST_INDEX_OF:
            return `(${this.listRef(node.list)}.indexOf(${this.descendInput(node.item)}) + 1)`;
        case InputOpcode.LIST_LENGTH:
            return `${this.listRef(node.list)}.len`;

        case InputOpcode.LOOKS_SIZE_GET:
            return 'Math.round(target.size)';
        case InputOpcode.LOOKS_BACKDROP_NAME:
            return 'stage.getCostumes()[stage.currentCostume].name';
        case InputOpcode.LOOKS_BACKDROP_NUMBER:
            return '(stage.currentCostume + 1)';
        case InputOpcode.LOOKS_COSTUME_NAME:
            return 'target.getCostumes()[target.currentCostume].name';
        case InputOpcode.LOOKS_COSTUME_NUMBER:
            return '(target.currentCostume + 1)';

        case InputOpcode.MOTION_DIRECTION_GET:
            return 'target.direction';
        case InputOpcode.MOTION_X_GET:
            return 'limitPrecision(target.x)';
        case InputOpcode.MOTION_Y_GET:
            return 'limitPrecision(target.y)';

        case InputOpcode.SENSING_MOUSE_DOWN:
            return 'runtime.ioDevices.mouse.getIsDown()';
        case InputOpcode.SENSING_MOUSE_X:
            return 'runtime.ioDevices.mouse.getScratchX()';
        case InputOpcode.SENSING_MOUSE_Y:
            return 'runtime.ioDevices.mouse.getScratchY()';

        case InputOpcode.OP_ABS:
            return `Math.abs(${this.descendInput(node.value)})`;
        case InputOpcode.OP_ACOS:
            return `((Math.acos(${this.descendInput(node.value)}) * 180) / Math.PI)`;
        case InputOpcode.OP_ADD:
            return `(${this.descendInput(node.left)} + ${this.descendInput(node.right)})`;
        case InputOpcode.OP_AND:
            return `(${this.descendInput(node.left)} && ${this.descendInput(node.right)})`;
        case InputOpcode.OP_ASIN:
            return `((Math.asin(${this.descendInput(node.value)}) * 180) / Math.PI)`;
        case InputOpcode.OP_ATAN:
            return `((Math.atan(${this.descendInput(node.value)}) * 180) / Math.PI)`;
        case InputOpcode.OP_CEILING:
            return `Math.ceil(${this.descendInput(node.value)})`;
        case InputOpcode.OP_CONTAINS:
            return `(${this.descendInput(node.string)}.toLowerCase().indexOf(${this.descendInput(node.contains)}.toLowerCase()) !== -1)`;
        case InputOpcode.OP_COS:
            return `(Math.round(Math.cos((Math.PI * ${this.descendInput(node.value)}) / 180) * 1e10) / 1e10)`;
        case InputOpcode.OP_DIVIDE:
            return `(${this.descendInput(node.left)} / ${this.descendInput(node.right)})`;
        case InputOpcode.OP_EQUALS: {
            const left = node.left;
            const right = node.right;

            // When either operand is known to never be a number, only use string comparison to avoid all number parsing.
            if (!left.isSometimesType(InputType.NUMBER_INTERPRETABLE) || !right.isSometimesType(InputType.NUMBER_INTERPRETABLE)) {
                // ttw (04 §6): a number can never equal a constant string that has no numeric interpretation.
                const rc = nonNumericStringConstant(right);
                const lc = rc === null ? nonNumericStringConstant(left) : null;
                const value = rc === null ? right : left;
                const constant = rc === null ? left : right;
                const c = rc === null ? lc : rc;
                if (c !== null && value.isSometimesType(InputType.NUMBER_OR_NAN)) {
                    const split = this.listGetSplit(value);
                    if (split !== null) {
                        const v = this.anyTemp();
                        return `(${split.cond} ? false : (${v} = ${split.any}, typeof ${v} === "number" ? false : ${this.equalsStringConstant(v, constant, c)}))`;
                    }
                    const [pre, v] = this.once(this.descendInput(value), false);
                    return `(${pre}typeof ${v} === "number" ? false : ${this.equalsStringConstant(v, constant, c)})`;
                }
                // Two strings, one of them constant: compare without lower-casing where possible.
                if (left.opcode === InputOpcode.CONSTANT || right.opcode === InputOpcode.CONSTANT) {
                    const constantInput = right.opcode === InputOpcode.CONSTANT ? right : left;
                    const otherInput = constantInput === right ? left : right;
                    const t = this.anyTemp();
                    return `(${t} = ${this.descendInput(otherInput.toType(InputType.STRING))}, ${equalsIgnoreCase(t, `${constantInput.inputs.value}`)})`;
                }
                return `(${this.descendInput(left.toType(InputType.STRING))}.toLowerCase() === ${this.descendInput(right.toType(InputType.STRING))}.toLowerCase())`;
            }
            // When both operands are known to be numbers, we can use ===
            if (left.isAlwaysType(InputType.NUMBER_INTERPRETABLE) && right.isAlwaysType(InputType.NUMBER_INTERPRETABLE)) {
                return `(${this.descendInput(left.toType(InputType.NUMBER))} === ${this.descendInput(right.toType(InputType.NUMBER))})`;
            }
            // In certain conditions, we can use === when one of the operands is known to be a safe number.
            if (isSafeInputForEqualsOptimization(left, right) || isSafeInputForEqualsOptimization(right, left)) {
                return `(${this.descendInput(left.toType(InputType.NUMBER))} === ${this.descendInput(right.toType(InputType.NUMBER))})`;
            }
            // No compile-time optimizations possible: inline the fast path of compareEqual at this site (07 R3).
            {
                const fused = this.fusedListCompare('===', 'eqSlow', left, right);
                if (fused !== null) return fused;
            }
            const [p1, a] = this.once(this.descendInput(left), false);
            const [p2, b] = this.once(this.descendInput(right), false);
            const fast = joinGuards([typeGuard(a, left), typeGuard(b, right), nanGuard(a, left), nanGuard(b, right)]);
            return `(${p1}${p2}(${fast} || ${a} === ${b}) ? ${a} === ${b} : eqSlow(${a}, ${b}))`;
        }
        case InputOpcode.OP_POW_E:
            return `Math.exp(${this.descendInput(node.value)})`;
        case InputOpcode.OP_FLOOR:
            return `Math.floor(${this.descendInput(node.value)})`;
        case InputOpcode.OP_GREATER: {
            const left = node.left;
            const right = node.right;
            if (left.isAlwaysType(InputType.NUMBER_INTERPRETABLE) && right.isAlwaysType(InputType.NUMBER_INTERPRETABLE | InputType.NUMBER_NAN)) {
                return `(${this.descendInput(left.toType(InputType.NUMBER))} > ${this.descendInput(right.toType(InputType.NUMBER_OR_NAN))})`;
            }
            if (left.isAlwaysType(InputType.NUMBER_INTERPRETABLE | InputType.NUMBER_NAN) && right.isAlwaysType(InputType.NUMBER_INTERPRETABLE)) {
                return `!(${this.descendInput(left.toType(InputType.NUMBER_OR_NAN))} <= ${this.descendInput(right.toType(InputType.NUMBER))})`;
            }
            if (!left.isSometimesType(InputType.NUMBER_INTERPRETABLE) || !right.isSometimesType(InputType.NUMBER_INTERPRETABLE)) {
                return `(${this.descendInput(left.toType(InputType.STRING))}.toLowerCase() > ${this.descendInput(right.toType(InputType.STRING))}.toLowerCase())`;
            }
            {
                const fused = this.fusedListCompare('>', 'gtSlow', left, right);
                if (fused !== null) return fused;
            }
            const [p1, a] = this.once(this.descendInput(left), false);
            const [p2, b] = this.once(this.descendInput(right), false);
            const fast = joinGuards([typeGuard(a, left), typeGuard(b, right), nanGuard(a, left)]);
            return `(${p1}${p2}(${fast}) ? ${a} > ${b} : gtSlow(${a}, ${b}))`;
        }
        case InputOpcode.OP_JOIN:
            return `(${this.descendInput(node.left)} + ${this.descendInput(node.right)})`;
        case InputOpcode.OP_LENGTH:
            return `${this.descendInput(node.string)}.length`;
        case InputOpcode.OP_LESS: {
            const left = node.left;
            const right = node.right;
            if (left.isAlwaysType(InputType.NUMBER_INTERPRETABLE | InputType.NUMBER_NAN) && right.isAlwaysType(InputType.NUMBER_INTERPRETABLE)) {
                return `(${this.descendInput(left.toType(InputType.NUMBER_OR_NAN))} < ${this.descendInput(right.toType(InputType.NUMBER))})`;
            }
            if (left.isAlwaysType(InputType.NUMBER_INTERPRETABLE) && right.isAlwaysType(InputType.NUMBER_INTERPRETABLE | InputType.NUMBER_NAN)) {
                return `!(${this.descendInput(left.toType(InputType.NUMBER))} >= ${this.descendInput(right.toType(InputType.NUMBER_OR_NAN))})`;
            }
            if (!left.isSometimesType(InputType.NUMBER_INTERPRETABLE) || !right.isSometimesType(InputType.NUMBER_INTERPRETABLE)) {
                return `(${this.descendInput(left.toType(InputType.STRING))}.toLowerCase() < ${this.descendInput(right.toType(InputType.STRING))}.toLowerCase())`;
            }
            {
                const fused = this.fusedListCompare('<', 'ltSlow', left, right);
                if (fused !== null) return fused;
            }
            const [p1, a] = this.once(this.descendInput(left), false);
            const [p2, b] = this.once(this.descendInput(right), false);
            const fast = joinGuards([typeGuard(a, left), typeGuard(b, right), nanGuard(b, right)]);
            return `(${p1}${p2}(${fast}) ? ${a} < ${b} : ltSlow(${a}, ${b}))`;
        }
        case InputOpcode.OP_LETTER_OF:
            return `((${this.descendInput(node.string)})[${this.descendInput(node.letter)} - 1] || "")`;
        case InputOpcode.OP_LOG_E:
            return `Math.log(${this.descendInput(node.value)})`;
        case InputOpcode.OP_LOG_10:
            return `(Math.log(${this.descendInput(node.value)}) / Math.LN10)`;
        case InputOpcode.OP_MOD:
            return this.descendMod(node);
        case InputOpcode.OP_MULTIPLY:
            return `(${this.descendInput(node.left)} * ${this.descendInput(node.right)})`;
        case InputOpcode.OP_NOT:
            return `!${this.descendInput(node.operand)}`;
        case InputOpcode.OP_OR:
            return `(${this.descendInput(node.left)} || ${this.descendInput(node.right)})`;
        case InputOpcode.OP_RANDOM:
            if (node.useInts) {
                return `randomInt(${this.descendInput(node.low)}, ${this.descendInput(node.high)})`;
            }
            if (node.useFloats) {
                return `randomFloat(${this.descendInput(node.low)}, ${this.descendInput(node.high)})`;
            }
            return `runtime.ext_scratch3_operators._random(${this.descendInput(node.low)}, ${this.descendInput(node.high)})`;
        case InputOpcode.OP_ROUND:
            return `Math.round(${this.descendInput(node.value)})`;
        case InputOpcode.OP_SIN:
            return `(Math.round(Math.sin((Math.PI * ${this.descendInput(node.value)}) / 180) * 1e10) / 1e10)`;
        case InputOpcode.OP_SQRT:
            return `Math.sqrt(${this.descendInput(node.value)})`;
        case InputOpcode.OP_SUBTRACT:
            return `(${this.descendInput(node.left)} - ${this.descendInput(node.right)})`;
        case InputOpcode.OP_TAN:
            return `tan(${this.descendInput(node.value)})`;
        case InputOpcode.OP_POW_10:
            return `(10 ** ${this.descendInput(node.value)})`;

        case InputOpcode.PROCEDURE_CALL: {
            if (this.isEmptyCall(node)) {
                // TODO still need to evaluate arguments for side effects (same as TW)
                return '""';
            }
            const callee = this.calleeOf(node.variant);
            if (callee.kind === 'resumable') {
                throw new Error('TTW: resumable call was not spilled');
            }
            const args = node.arguments.map(arg => this.descendInput(arg));
            return this.nativeCallExpression(callee, args);
        }
        case InputOpcode.SENSING_ANSWER:
            return `runtime.ext_scratch3_sensing._answer`;
        case InputOpcode.SENSING_COLOR_TOUCHING_COLOR:
            return `target.colorIsTouchingColor(${this.descendInput(node.target)}, ${this.descendInput(node.mask)})`;
        case InputOpcode.SENSING_TIME_DATE:
            return `(new Date().getDate())`;
        case InputOpcode.SENSING_TIME_WEEKDAY:
            return `(new Date().getDay() + 1)`;
        case InputOpcode.SENSING_TIME_DAYS_SINCE_2000:
            return 'daysSince2000()';
        case InputOpcode.SENSING_DISTANCE:
            return `distance(target, ${this.descendInput(node.target)})`;
        case InputOpcode.SENSING_TIME_HOUR:
            return `(new Date().getHours())`;
        case InputOpcode.SENSING_TIME_MINUTE:
            return `(new Date().getMinutes())`;
        case InputOpcode.SENSING_TIME_MONTH:
            return `(new Date().getMonth() + 1)`;
        case InputOpcode.SENSING_OF:
            // getAttributeOf may read variables of other targets: flush first.
            return `(${this.flushAllExpressionPrefix()}runtime.ext_scratch3_sensing.getAttributeOf({OBJECT: ${this.descendInput(node.object)}, PROPERTY: ${str(node.property)} }))`;
        case InputOpcode.SENSING_OF_VOLUME:
            return this.ofTarget(node.object, r => `${r}.volume`);
        case InputOpcode.SENSING_OF_BACKDROP_NUMBER:
            return `(stage.currentCostume + 1)`;
        case InputOpcode.SENSING_OF_BACKDROP_NAME:
            return `stage.getCostumes()[stage.currentCostume].name`;
        case InputOpcode.SENSING_OF_POS_X:
            return this.ofTarget(node.object, r => `${r}.x`);
        case InputOpcode.SENSING_OF_POS_Y:
            return this.ofTarget(node.object, r => `${r}.y`);
        case InputOpcode.SENSING_OF_DIRECTION:
            return this.ofTarget(node.object, r => `${r}.direction`);
        case InputOpcode.SENSING_OF_COSTUME_NUMBER:
            return this.ofTarget(node.object, r => `${r}.currentCostume + 1`);
        case InputOpcode.SENSING_OF_COSTUME_NAME:
            return this.ofTarget(node.object, r => `${r}.getCostumes()[${r}.currentCostume].name`);
        case InputOpcode.SENSING_OF_SIZE:
            return this.ofTarget(node.object, r => `${r}.size`);
        case InputOpcode.SENSING_OF_VAR: {
            const t = this.anyTemp();
            const v = this.anyTemp();
            const ref = this.targetReference(node.object, t);
            return `(${this.flushAllExpressionPrefix()}${ref.pre}(${v} = ${ref.name} && ${ref.name}.lookupVariableByNameAndType(${str(node.property)}, "", true)) ? ${v}.value : 0)`;
        }
        case InputOpcode.SENSING_TIME_SECOND:
            return `(new Date().getSeconds())`;
        case InputOpcode.SENSING_TOUCHING_OBJECT:
            return `target.isTouchingObject(${this.descendInput(node.object)})`;
        case InputOpcode.SENSING_TOUCHING_COLOR:
            return `target.isTouchingColor(${this.descendInput(node.color)})`;
        case InputOpcode.SENSING_USERNAME:
            return 'runtime.ioDevices.userData.getUsername()';
        case InputOpcode.SENSING_TIME_YEAR:
            return `(new Date().getFullYear())`;

        case InputOpcode.SENSING_TIMER_GET:
            return 'runtime.ioDevices.clock.projectTimer()';

        case InputOpcode.CONTROL_COUNTER:
            return 'runtime.ext_scratch3_control._counter';

        case InputOpcode.TW_KEY_LAST_PRESSED:
            return 'runtime.ioDevices.keyboard.getLastKeyPressed()';

        case InputOpcode.VAR_GET:
            return this.readVariable(node.variable);

        default:
            log.warn(`TTW: Unknown input: ${block.opcode}`, node);
            throw new Error(`TTW: Unknown input: ${block.opcode}`);
        }
    }

    /**
     * @param {IntermediateInput} input object reference (string)
     * @param {string} temp any temp to hold the target
     * @returns {{pre: string, name: string}} evaluation prefix and name of the target (or null)
     */
    targetReference (input, temp) {
        if (!input.isAlwaysType(InputType.STRING)) {
            throw new Error(`JS: Object references must be strings!`);
        }
        if (input.isConstant('_stage_')) return {pre: '', name: 'stage'};
        return {pre: `${temp} = runtime.getSpriteTargetByName(${this.descendInput(input)}), `, name: temp};
    }

    /**
     * @param {IntermediateInput} object object reference
     * @param {(ref: string) => string} property property of the target
     * @returns {string} `(target ? property : 0)`
     */
    ofTarget (object, property) {
        const ref = this.targetReference(object, this.anyTemp());
        return `(${ref.pre}${ref.name} ? ${property(ref.name)} : 0)`;
    }

    /**
     * Scratch mod. Integer fast path for a positive integer constant modulus (04 §6).
     * @param {*} node OP_MOD inputs
     * @returns {string} JS expression
     */
    descendMod (node) {
        this.descendedIntoModulo = true;
        const right = node.right;
        if (right.opcode === InputOpcode.CONSTANT && typeof right.inputs.value === 'number') {
            const m = right.inputs.value;
            if (Number.isInteger(m) && m > 0 && m <= 4294967296) {
                const q = this.numTemp();
                const t = this.numTemp();
                // Non-negative int32 (including -0): JS % is exact and V8 uses integer modulus.
                // Other non-negative integers below 2^52: q - floor(q / m) * m with one correction step.
                return `((${q} = ${this.descendInput(node.left)}) >= 0 && (${q} | 0) === ${q} ? ${q} % ${m} : ${q} >= 1 && ${q} <= ${MAX_SAFE_MOD} && ${q} === Math.floor(${q}) ? ((${t} = ${q} - Math.floor(${q} / ${m}) * ${m}) < 0 ? ${t} + ${m} : (${t} >= ${m} ? ${t} - ${m} : ${t})) : (${t} = ${q} % ${m}, ${t} / ${m} < 0 ? ${t} + ${m} : ${t}))`;
            }
        }
        const a = this.numTemp();
        const b = this.numTemp();
        const t = this.numTemp();
        return `(${a} = ${this.descendInput(node.left)}, ${b} = ${this.descendInput(node.right)}, ${t} = ${a} % ${b}, ${t} / ${b} < 0 ? ${t} + ${b} : ${t})`;
    }

    // ------------------------------------------------------------------ lists (03 §5)

    // ------------------------------------------------------------------ numeric view sharing (04 §4)

    /**
     * @param {*} block stack block
     * @returns {Set<string>} keys of variables a block (including its substacks and callees) may assign
     */
    assignedVariables (block) {
        const keys = new Set();
        const noteCall = node => {
            const callee = this.calleeOf(node.variant);
            if (callee) for (const key of callee.mod) keys.add(key);
        };
        walkStack(new IntermediateStack([block]), {
            block: b => {
                if (b.opcode === StackOpcode.VAR_SET || b.opcode === StackOpcode.CONTROL_FOR) {
                    keys.add(this.sprite.varKey(b.inputs.variable));
                } else if (b.opcode === StackOpcode.PROCEDURE_CALL) {
                    noteCall(b.inputs);
                }
            },
            input: input => {
                if (input.opcode === InputOpcode.PROCEDURE_CALL) noteCall(input.inputs);
            }
        });
        return keys;
    }

    /**
     * @param {Set<string>} keys variables that were (or may be) assigned
     */
    invalidateCasts (keys) {
        for (const key of keys) this.castCache.delete(key);
    }

    /**
     * Find casts of promoted variables in some inputs. Returns null if the inputs contain a procedure call
     * (a callee could assign the variable between the hoisted cast and its use).
     * @param {IntermediateInput[]} inputs inputs
     * @returns {Map<string, IntermediateInput>|null} variable key -> a CAST_NUMBER node
     */
    castsIn (inputs) {
        const found = new Map();
        let hasCall = false;
        const visit = input => {
            if (input.opcode === InputOpcode.PROCEDURE_CALL && !this.isEmptyCall(input.inputs)) hasCall = true;
            if (input.opcode === InputOpcode.CAST_NUMBER && input.inputs.target.opcode === InputOpcode.VAR_GET &&
                !input.inputs.target.isAlwaysType(InputType.BOOLEAN)) {
                const variable = input.inputs.target.inputs.variable;
                const key = this.sprite.varKey(variable);
                const info = this.vars.get(key);
                if (info && info.v && !this.castCache.has(key) && !found.has(key)) found.set(key, input);
            }
            forEachChild(input.inputs, visit);
        };
        for (const input of inputs) visit(input);
        return hasCall ? null : found;
    }

    /**
     * Compute the casts used by some inputs once, before they are evaluated.
     * @param {IntermediateInput[]} inputs inputs
     * @returns {string[]} assignments (to be emitted as statements or in a comma expression)
     */
    hoistCasts (inputs) {
        if (this.resumable) return [];
        const found = this.castsIn(inputs);
        if (found === null) return [];
        const out = [];
        for (const [key, node] of found) {
            const t = this.numTemp();
            out.push(`${t} = ${this.descendInput(node)}`);
            this.castCache.set(key, t);
        }
        return out;
    }

    /**
     * @param {*} block stack block
     * @returns {IntermediateInput[]} inputs evaluated once, before the block runs
     */
    hoistableInputs (block) {
        const out = [];
        forEachChild(block.inputs, child => {
            out.push(child);
        });
        if (block.opcode === StackOpcode.CONTROL_WHILE) return [];
        if (block.opcode === StackOpcode.CONTROL_FOR) return [];
        return out;
    }

    /**
     * Emit a native block with numeric view sharing.
     * @param {*} block stack block
     */
    nativeBlock (block) {
        if (this.chunkLoops && this.stackDepth === 1 && this.chunkBox === null && LOOP_OPCODES.has(block.opcode) &&
            !(block.opcode === StackOpcode.CONTROL_REPEAT && block.inputs.times.opcode === InputOpcode.CONSTANT &&
                +block.inputs.times.inputs.value < 256)) {
            // Small constant repeats are not worth a chunk function.
            this.emitChunkedLoop(block);
            return;
        }
        const casts = this.hoistCasts(this.hoistableInputs(block));
        if (casts.length) this.src += `${casts.join(';\n')};\n`;
        this.descendStackedBlock(block);
        if (block.opcode === StackOpcode.VAR_SET || block.opcode === StackOpcode.CONTROL_FOR ||
            block.opcode === StackOpcode.PROCEDURE_CALL || this.castsIn(this.hoistableInputs(block)) === null ||
            LOOP_OPCODES.has(block.opcode) || block.opcode === StackOpcode.CONTROL_IF_ELSE) {
            this.invalidateCasts(this.assignedVariables(block));
        }
    }

    /**
     * Emit the top-level statements of an oversized native unit as part functions (07 §4). A part returns
     * CONTINUE to fall through to the next part; anything else is the unit's result (its exits `return`).
     * @param {IntermediateStack} stack top-level stack
     */
    emitSplitParts (stack) {
        const groups = [];
        let current = [];
        let size = 0;
        for (const block of stack.blocks) {
            const n = countNodes(new IntermediateStack([block]));
            if (current.length && size + n > PART_NODES) {
                groups.push(current);
                current = [];
                size = 0;
            }
            current.push(block);
            size += n;
        }
        if (current.length) groups.push(current);
        const args = this.script.arguments.map((_, i) => `, p${i}`).join('');
        const result = this.anyTemp();
        const mainSrc = this.src;
        for (let i = 0; i < groups.length; i++) {
            const name = `${this.fnName}$part${i}`;
            this.src = '';
            this.descendStack(new IntermediateStack(groups[i]), new Frame(false));
            this.parts.push({name, body: this.src});
        }
        this.src = mainSrc;
        for (let i = 0; i < groups.length; i++) {
            this.src += `if ((${result} = ${this.fnName}$part${i}(th, S${args})) !== CONTINUE) return ${result};\n`;
        }
    }

    /**
     * Run a top-level loop in a chunk function (07 §5).
     * @param {*} block loop block
     */
    emitChunkedLoop (block) {
        const name = `${this.fnName}$c${this.chunks.length}`;
        const box = this.anyTemp();
        const result = this.numTemp();
        const promoted = [...this.vars.values()].filter(info => info.v);
        let init = '0';
        if (block.opcode === StackOpcode.CONTROL_REPEAT) {
            init = this.descendInput(block.inputs.times);
        }
        const fields = promoted.map(info => `${info.v}: ${info.v}, `).join('');
        const args = this.script.arguments.map((_, i) => `, p${i}`).join('');
        this.src += `${box} = {${fields}c: ${init}, k: 1, r: ""};\n`;
        this.src += `while ((${result} = ${name}(th, S${args}, B)) === 1);\n`.replace(', B)', `, ${box})`);
        for (const info of promoted) this.src += `${info.v} = ${box}.${info.v};\n`;
        this.castCache.clear();

        const savedSrc = this.src;
        this.src = '';
        this.chunkBox = 'B';
        this.chunkTop = true;
        this.descendStackedBlock(block);
        this.chunkTop = false;
        const body = this.src;
        this.chunkBox = null;
        this.castCache.clear();
        this.src = savedSrc;
        this.chunks.push({name, body});

        if (this.isProcedure) {
            this.src += `if (${result} === 2) {\n`;
            this.returnFromProcedure(`${box}.r`);
            this.src += '}\n';
        } else {
            this.src += `if (${result} === 2) {\n${this.exitFlush()}return;\n}\n`;
        }
    }

    /**
     * Inside a chunk function's outer loop: code that ends the chunk when its iteration budget is used up.
     * @param {string} budget numeric temp counting the remaining iterations
     * @param {string} saveCounter statement saving the loop counter, if any
     * @returns {string} code
     */
    chunkBudgetCheck (budget, saveCounter) {
        return `if (${budget}-- === 0) { ${saveCounter}${this.chunkSave()}return 1; }\n`;
    }

    /**
     * Emit a substack (branch or loop body) without leaking casts computed inside it.
     * @param {IntermediateStack} stack stack
     * @param {Frame} frame frame
     * @param {Set<string>} [invalid] variables to forget before the stack (assigned in an enclosing loop)
     */
    descendSubstack (stack, frame, invalid) {
        if (this.resumable) {
            this.descendStack(stack, frame);
            return;
        }
        const saved = new Map(this.castCache);
        if (invalid) this.invalidateCasts(invalid);
        this.descendStack(stack, frame);
        this.castCache = saved;
    }

    /**
     * Range check hoisting for the most common list loop in Scratch projects:
     *
     *     repeat (n) { ... item (i) of L ... replace item (i) of L ... change i by 1 }
     *
     * If `i` is only changed by the loop's last statement (by exactly 1) and the length of L can't change
     * inside the loop, then every `item (i) of L` is in range iff `i >= 1 && i + n - 1 <= length of L` when
     * the loop is entered. The loop is emitted twice; the version behind that check does no per-access
     * range checks, and reads of PURE lists there are plain numbers instead of "number or empty string".
     * @param {*} block CONTROL_REPEAT block (native unit)
     * @returns {{key: string, v: string, lists: Set<string>}|null} plan, or null if not applicable
     */
    rangePlan (block) {
        if (this.resumable || this.inRange !== null) return null;
        if (this.m.runtime.compilerOptions.ttwRangeLoops === false) return null;
        const body = block.inputs.do;
        if (!body || body.blocks.length < 2) return null;
        const last = body.blocks[body.blocks.length - 1];
        if (last.opcode !== StackOpcode.VAR_SET) return null;
        const variable = last.inputs.variable;
        const key = this.sprite.varKey(variable);
        const info = this.vars.get(key);
        if (!info || !info.v) return null;
        const isVar = input => input.opcode === InputOpcode.VAR_GET && this.sprite.varKey(input.inputs.variable) === key;
        const isVarNumber = input => isVar(input) ||
            (input.opcode === InputOpcode.CAST_NUMBER && isVar(input.inputs.target));
        const isOne = input => input.opcode === InputOpcode.CONSTANT && +input.inputs.value === 1 &&
            input.isAlwaysType(InputType.NUMBER);
        const value = last.inputs.value;
        if (value.opcode !== InputOpcode.OP_ADD) return null;
        if (!(isVarNumber(value.inputs.left) && isOne(value.inputs.right)) &&
            !(isOne(value.inputs.left) && isVarNumber(value.inputs.right))) return null;

        let ok = true;
        let size = 0;
        const indexed = new Map();
        const resized = new Set();
        const noteCall = node => {
            if (this.isEmptyCall(node)) return;
            const callee = this.calleeOf(node.variant);
            if (!callee || callee.mod.has(key)) {
                ok = false;
                return;
            }
            for (const listKey of callee.lmod) resized.add(listKey);
        };
        const noteIndexed = node => {
            if (isVar(node.index) && node.index.isAlwaysType(InputType.NUMBER_OR_NAN)) {
                indexed.set(this.sprite.varKey(node.list), this.listRef(node.list));
            }
        };
        walkStack(body, {
            block: b => {
                size++;
                switch (b.opcode) {
                case StackOpcode.VAR_SET:
                case StackOpcode.CONTROL_FOR:
                    if (b !== last && this.sprite.varKey(b.inputs.variable) === key) ok = false;
                    break;
                case StackOpcode.LIST_ADD:
                case StackOpcode.LIST_INSERT:
                case StackOpcode.LIST_DELETE:
                case StackOpcode.LIST_DELETE_ALL:
                    resized.add(this.sprite.varKey(b.inputs.list));
                    break;
                case StackOpcode.LIST_REPLACE:
                    noteIndexed(b.inputs);
                    break;
                case StackOpcode.PROCEDURE_CALL:
                    noteCall(b.inputs);
                    break;
                }
            },
            input: input => {
                size++;
                if (input.opcode === InputOpcode.LIST_GET) noteIndexed(input.inputs);
                else if (input.opcode === InputOpcode.PROCEDURE_CALL) noteCall(input.inputs);
            }
        });
        if (!ok) return null;
        const lists = new Set();
        for (const [listKey, L] of indexed) {
            if (!resized.has(listKey)) lists.add(L);
        }
        if (lists.size === 0 || size > this.versioningBudget) return null;
        this.versioningBudget -= size;
        return {key, v: info.v, lists};
    }

    /**
     * Emit a `repeat` loop whose counter has already been initialized, in an "in range" version and a
     * general version if rangePlan() applies.
     * @param {*} block CONTROL_REPEAT block
     * @param {string} counter numeric temp holding the remaining iterations
     * @param {() => void} emitLoop emits the loop statement
     */
    emitRangeVersions (block, counter, emitLoop) {
        const plan = this.rangePlan(block);
        if (plan === null) {
            emitLoop();
            return;
        }
        const {v} = plan;
        const conds = [`typeof ${v} === "number"`, `${v} >= 1`, `(${counter} | 0) === ${counter}`];
        for (const L of plan.lists) conds.push(`${v} + ${counter} - 1 <= ${L}.len`);
        this.src += `if (${conds.join(' && ')}) {\n`;
        const saved = new Map(this.castCache);
        this.inRange = plan;
        emitLoop();
        this.inRange = null;
        this.src += '} else {\n';
        this.castCache = new Map(saved);
        // The general version must not be versioned again by loops nested in it... but they may be: they
        // get their own plans. Only this loop's plan is disabled here.
        emitLoop();
        this.castCache = saved;
        this.src += '}\n';
    }

    /**
     * @param {string} L list local
     * @param {IntermediateInput} index index input
     * @returns {boolean} true if `item (index) of L` is known to exist here
     */
    isInRange (L, index) {
        const plan = this.inRange;
        return plan !== null && plan.lists.has(L) && index.opcode === InputOpcode.VAR_GET &&
            this.sprite.varKey(index.inputs.variable) === plan.key;
    }

    /**
     * @param {*} block loop block (native unit)
     * @returns {Set<string>|null} list locals to guard if the loop nest can be versioned
     */
    versionableLists (block) {
        if (this.resumable || this.pureLists !== null || this.inGeneralVersion) return null;
        const lists = new Set();
        const keys = new Set();
        const callees = [];
        let ok = true;
        let size = 0;
        const noteList = list => {
            keys.add(this.sprite.varKey(list));
            lists.add(this.listRef(list));
        };
        walkStack(new IntermediateStack([block]), {
            block: b => {
                size++;
                switch (b.opcode) {
                case StackOpcode.LIST_ADD:
                case StackOpcode.LIST_REPLACE:
                case StackOpcode.LIST_INSERT:
                    noteList(b.inputs.list);
                    if (!b.inputs.item.isAlwaysType(InputType.NUMBER_OR_NAN)) ok = false;
                    break;
                case StackOpcode.LIST_DELETE:
                case StackOpcode.LIST_DELETE_ALL:
                    noteList(b.inputs.list);
                    break;
                case StackOpcode.PROCEDURE_CALL:
                    callees.push(this.calleeOf(b.inputs.variant));
                    break;
                }
            },
            input: input => {
                size++;
                switch (input.opcode) {
                case InputOpcode.LIST_GET:
                case InputOpcode.LIST_LENGTH:
                case InputOpcode.LIST_CONTAINS:
                case InputOpcode.LIST_INDEX_OF:
                case InputOpcode.LIST_CONTENTS:
                    noteList(input.inputs.list);
                    break;
                case InputOpcode.PROCEDURE_CALL:
                    callees.push(this.calleeOf(input.inputs.variant));
                    break;
                }
            }
        });
        if (!ok || lists.size === 0 || size > this.versioningBudget) return null;
        for (const callee of callees) {
            if (!callee) continue;
            for (const key of callee.lmodnn) {
                if (keys.has(key)) return null;
            }
        }
        this.versioningBudget -= size;
        return lists;
    }

    /**
     * Emit a loop, versioned for PURE lists when possible (04 §5).
     * @param {*} block loop block
     * @param {() => void} emit emits the loop
     */
    emitMaybeVersionedLoop (block, emit) {
        const lists = this.versionableLists(block);
        if (lists === null) {
            emit();
            return;
        }
        this.src += `if (${[...lists].map(L => `${L}.objs.length === 0`).join(' && ')}) {\n`;
        const saved = new Map(this.castCache);
        this.pureLists = lists;
        emit();
        this.pureLists = null;
        this.src += '} else {\n';
        this.castCache = new Map(saved);
        this.inGeneralVersion = true;
        emit();
        this.inGeneralVersion = false;
        this.castCache = saved;
        this.src += '}\n';
    }

    /**
     * @param {string} L list local
     * @returns {boolean} true if the list is known to contain only numbers here
     */
    isPure (L) {
        return this.pureLists !== null && this.pureLists.has(L);
    }

    /**
     * @param {*} node LIST_GET inputs
     * @returns {string} read in ANY context
     */
    listGetAny (node) {
        const L = this.listRef(node.list);
        const index = node.index;
        if (this.isInRange(L, index)) {
            const iv = this.inRange.v;
            if (this.isPure(L)) return `${L}.f64[(${iv} | 0) - 1]`;
            const x2 = this.numTemp();
            const k2 = this.numTemp();
            const o2 = this.anyTemp();
            return `((${x2} = ${L}.f64[${k2} = (${iv} | 0) - 1]) === ${x2} ? ${x2} : ((${o2} = ${L}.objs[${k2}]) === undefined ? NaN : ${o2}))`;
        }
        if (this.isPure(L) && index.isAlwaysType(InputType.NUMBER_OR_NAN)) {
            // PURE: every element is a number (possibly NaN); out of range is "".
            const i = this.numTemp();
            return `((${i} = ${this.descendInput(index)}) >= 1 && ${i} <= ${L}.len ? ${L}.f64[(${i} | 0) - 1] : "")`;
        }
        const x = this.numTemp();
        const k = this.numTemp();
        const o = this.anyTemp();
        const element = `((${x} = ${L}.f64[${k}]) === ${x} ? ${x} : ((${o} = ${L}.objs[${k}]) === undefined ? NaN : ${o}))`;
        if (index.isConstant('last')) {
            return `((${k} = ${L}.len - 1) >= 0 ? ${element} : "")`;
        }
        if (index.isAlwaysType(InputType.NUMBER_OR_NAN)) {
            const i = this.numTemp();
            return `((${i} = ${this.descendInput(index)}) >= 1 && ${i} <= ${L}.len ? (${k} = (${i} | 0) - 1, ${element}) : "")`;
        }
        const i = this.anyTemp();
        return `(typeof (${i} = ${this.descendInput(index)}) === "number" ? (${i} >= 1 && ${i} <= ${L}.len ? (${k} = (${i} | 0) - 1, ${element}) : "") : ${L}.getSlow(${i}))`;
    }

    /**
     * A list read split into its numeric fast path and the general read, so that a consumer with its own
     * numeric fast path (comparison, list store) never materializes an "any" value on the hot path: V8
     * would have to box the number to merge it with the string cases.
     * `cond` evaluates the index and is true iff the item is a non-NaN number, which is then in `num`.
     * `any` is the complete read; it may only be evaluated after `cond`.
     * @param {IntermediateInput} input input
     * @returns {{cond: string, num: string, any: string}|null} null if the input is not such a read
     */
    listGetSplit (input) {
        if (input.opcode !== InputOpcode.LIST_GET) return null;
        const node = input.inputs;
        const index = node.index;
        if (!index.isAlwaysType(InputType.NUMBER_OR_NAN)) return null;
        const L = this.listRef(node.list);
        if (this.isInRange(L, index)) {
            const iv = this.inRange.v;
            const x2 = this.numTemp();
            const k2 = this.numTemp();
            const cond2 = `(${x2} = ${L}.f64[${k2} = (${iv} | 0) - 1]) === ${x2}`;
            if (this.isPure(L)) return {cond: cond2, num: x2, any: `${L}.f64[${k2}]`};
            const o2 = this.anyTemp();
            return {
                cond: cond2,
                num: x2,
                any: `((${x2} = ${L}.f64[${k2}]) === ${x2} ? ${x2} : ((${o2} = ${L}.objs[${k2}]) === undefined ? NaN : ${o2}))`
            };
        }
        const i = this.numTemp();
        const x = this.numTemp();
        const k = this.numTemp();
        const cond = `(${i} = ${this.descendInput(index)}) >= 1 && ${i} <= ${L}.len && ` +
            `(${x} = ${L}.f64[(${i} | 0) - 1]) === ${x}`;
        let any;
        if (this.isPure(L)) {
            any = `(${i} >= 1 && ${i} <= ${L}.len ? ${L}.f64[(${i} | 0) - 1] : "")`;
        } else {
            const o = this.anyTemp();
            any = `(${i} >= 1 && ${i} <= ${L}.len ? (${k} = (${i} | 0) - 1, ((${x} = ${L}.f64[${k}]) === ${x} ? ${x} : ` +
                `((${o} = ${L}.objs[${k}]) === undefined ? NaN : ${o}))) : "")`;
        }
        return {cond, num: x, any};
    }

    /**
     * @param {*} node ttw.inline inputs
     * @returns {Set<string>} argument temporaries whose every use in the inlined body is a number cast,
     * and whose argument isn't already known to be a number
     */
    numericOnlyTemps (node) {
        const all = new Map();
        const numeric = new Map();
        const count = (map, js) => map.set(js, (map.get(js) || 0) + 1);
        walkStack(node.body, {
            input: input => {
                if (input.opcode === RAW_OPCODE) {
                    count(all, input.inputs.js);
                } else if (input.opcode === InputOpcode.CAST_NUMBER && input.inputs.target.opcode === RAW_OPCODE) {
                    count(numeric, input.inputs.target.inputs.js);
                }
            }
        });
        const result = new Set();
        for (let k = 0; k < node.args.length; k++) {
            const temp = node.temps[k];
            if (node.args[k].isAlwaysType(InputType.NUMBER)) continue;
            if (all.has(temp) && all.get(temp) === numeric.get(temp)) result.add(temp);
        }
        return result;
    }

    /**
     * @param {IntermediateInput} input input
     * @returns {boolean} true if evaluating the input can't change any state (so it may be reordered)
     */
    isEffectFree (input) {
        let pure = true;
        walkInput(input, {
            input: child => {
                if (child.opcode === InputOpcode.PROCEDURE_CALL) pure = false;
            }
        }, 0);
        return pure;
    }

    /**
     * Fused comparison of a list read with another operand (see listGetSplit).
     * @param {string} op ">", "<" or "==="
     * @param {string} slow slow path function
     * @param {IntermediateInput} left left operand
     * @param {IntermediateInput} right right operand
     * @returns {string|null} JS expression, or null if neither operand is a splittable list read
     */
    fusedListCompare (op, slow, left, right) {
        const leftIsRead = left.opcode === InputOpcode.LIST_GET;
        const other = leftIsRead ? right : left;
        if (!this.isEffectFree(other)) return null;
        const split = this.listGetSplit(leftIsRead ? left : right);
        if (split === null) return null;
        const [pre, o] = this.once(this.descendInput(other), false);
        // The read's own guards are part of split.cond. NaN on the other side must take the slow path
        // unless the comparison tolerates it there (see the unfused code for each operator).
        const otherNeedsNanGuard = op === '===' || (op === '>' ? !leftIsRead : leftIsRead);
        const guards = joinGuards([typeGuard(o, other), otherNeedsNanGuard ? nanGuard(o, other) : '']);
        const fast = leftIsRead ? `${split.num} ${op} ${o}` : `${o} ${op} ${split.num}`;
        const general = leftIsRead ? `${slow}(${split.any}, ${o})` : `${slow}(${o}, ${split.any})`;
        return `(${pre}(${split.cond} && ${guards}) ? ${fast} : ${general})`;
    }

    /**
     * @param {string} v JS name holding a value that is not a number
     * @param {IntermediateInput} constant constant string input
     * @param {string} lower its lower case value
     * @returns {string} JS condition: the value equals the constant (case insensitive string comparison)
     */
    equalsStringConstant (v, constant, lower) {
        // Nothing but the empty string converts to the empty string.
        if (lower === '') return `("" + ${v}).length === 0`;
        const t = this.anyTemp();
        return `(${t} = "" + ${v}, ${equalsIgnoreCase(t, constant.inputs.value)})`;
    }

    /**
     * @param {*} node LIST_GET inputs
     * @returns {string} read in a numeric context (toNumber applied)
     */
    listGetNumber (node) {
        const L = this.listRef(node.list);
        const index = node.index;
        const x = this.numTemp();
        if (index.isConstant('last')) {
            const k = this.numTemp();
            return `((${k} = ${L}.len - 1) >= 0 && (${x} = ${L}.f64[${k}]) === ${x} ? ${x} : ${L}.numSlow("last"))`;
        }
        if (this.isInRange(L, index)) {
            const iv = this.inRange.v;
            return `((${x} = ${L}.f64[(${iv} | 0) - 1]) === ${x} ? ${x} : ${this.isPure(L) ? '0' : `${L}.numSlow(${iv})`})`;
        }
        if (index.isAlwaysType(InputType.NUMBER_OR_NAN)) {
            const i = this.numTemp();
            // PURE: the cold value is the constant 0 (NaN element or out of range), so no call in the loop.
            const cold = this.isPure(L) ? '0' : `${L}.numSlow(${i})`;
            return `((${i} = ${this.descendInput(index)}) >= 1 && ${i} <= ${L}.len && (${x} = ${L}.f64[(${i} | 0) - 1]) === ${x} ? ${x} : ${cold})`;
        }
        const i = this.anyTemp();
        return `(typeof (${i} = ${this.descendInput(index)}) === "number" && ${i} >= 1 && ${i} <= ${L}.len && (${x} = ${L}.f64[(${i} | 0) - 1]) === ${x} ? ${x} : ${L}.numSlow(${i}))`;
    }

    /**
     * @param {*} node LIST_REPLACE inputs
     * @returns {string} statement
     */
    listReplace (node) {
        const L = this.listRef(node.list);
        const index = node.index;
        if (!index.isAlwaysType(InputType.NUMBER_OR_NAN)) {
            return `${L}.setSlow(${this.descendInput(index)}, ${this.descendInput(node.item)});\n`;
        }
        if (this.isInRange(L, index)) return this.listReplaceInRange(node, L);
        const i = this.numTemp();
        const k = this.numTemp();
        let src = `${i} = ${this.descendInput(index)};\n`;
        const store = `${L}.f64[${k} = (${i} | 0) - 1] = `;
        if (node.item.isAlwaysType(InputType.NUMBER_OR_NAN)) {
            const v = this.numTemp();
            src += `${v} = ${this.descendInput(node.item)};\n`;
            if (this.isPure(L)) {
                src += `if (${i} >= 1 && ${i} <= ${L}.len) ${L}.f64[(${i} | 0) - 1] = ${v};\n`;
            } else {
                src += `if (${i} >= 1 && ${i} <= ${L}.len) { ${store}${v}; if (${L}.objs.length !== 0 && ${L}.objs[${k}] !== undefined) ${L}.clearObj(${k}); }\n`;
            }
        } else {
            const split = this.listGetSplit(node.item);
            if (split === null) {
                const v = this.anyTemp();
                src += `${v} = ${this.descendInput(node.item)};\n`;
                src += `if (typeof ${v} === "number" && ${i} >= 1 && ${i} <= ${L}.len) { ${store}${v}; if (${L}.objs.length !== 0 && ${L}.objs[${k}] !== undefined) ${L}.clearObj(${k}); } else ${L}.setSlow(${i}, ${v});\n`;
            } else {
                // Copying an item: numbers go from one Float64Array to the other without becoming a JS value.
                // (setSlow ignores out of range indexes, so it also covers a number with a bad index.)
                src += `if (${split.cond} && ${i} >= 1 && ${i} <= ${L}.len) { ${store}${split.num}; if (${L}.objs.length !== 0 && ${L}.objs[${k}] !== undefined) ${L}.clearObj(${k}); } else ${L}.setSlow(${i}, ${split.any});\n`;
            }
        }
        src += this.markListChanged(L);
        return src;
    }

    /**
     * @param {*} node LIST_REPLACE inputs whose index is known to be in range (see rangePlan)
     * @param {string} L list local
     * @returns {string} statement
     */
    listReplaceInRange (node, L) {
        const iv = this.inRange.v;
        const k = this.numTemp();
        const clear = this.isPure(L) ? '' : ` if (${L}.objs.length !== 0 && ${L}.objs[${k}] !== undefined) ${L}.clearObj(${k});`;
        let src;
        if (node.item.isAlwaysType(InputType.NUMBER_OR_NAN)) {
            const v = this.numTemp();
            src = `${v} = ${this.descendInput(node.item)};\n`;
            src += `${L}.f64[${k} = (${iv} | 0) - 1] = ${v};${clear}\n`;
        } else {
            const split = this.listGetSplit(node.item);
            if (split === null) {
                const v = this.anyTemp();
                src = `${v} = ${this.descendInput(node.item)};\n`;
                src += `if (typeof ${v} === "number") { ${L}.f64[${k} = (${iv} | 0) - 1] = ${v};${clear} } else ${L}.setSlow(${iv}, ${v});\n`;
            } else {
                src = `if (${split.cond}) { ${L}.f64[${k} = (${iv} | 0) - 1] = ${split.num};${clear} } else ${L}.setSlow(${iv}, ${split.any});\n`;
            }
        }
        src += this.markListChanged(L);
        return src;
    }

    /**
     * @param {*} node LIST_ADD inputs
     * @returns {string} statement
     */
    listAdd (node) {
        const L = this.listRef(node.list);
        let src;
        if (node.item.isAlwaysType(InputType.NUMBER_OR_NAN)) {
            const v = this.numTemp();
            src = `${v} = ${this.descendInput(node.item)};\n`;
            if (this.isPure(L)) {
                src += `if (${L}.len < ${L}.f64.length) ${L}.f64[${L}.len++] = ${v}; else ${L}.pushSlow(${v});\n`;
            } else {
                src += `if (${L}.len < ${L}.f64.length && ${L}.objs.length === 0) ${L}.f64[${L}.len++] = ${v}; else ${L}.pushSlow(${v});\n`;
            }
        } else {
            const split = this.listGetSplit(node.item);
            if (split === null) {
                const v = this.anyTemp();
                src = `${v} = ${this.descendInput(node.item)};\n`;
                src += `if (typeof ${v} === "number" && ${L}.len < ${L}.f64.length && ${L}.objs.length === 0) ${L}.f64[${L}.len++] = ${v}; else ${L}.pushSlow(${v});\n`;
            } else {
                src = `if (${split.cond} && ${L}.len < ${L}.f64.length && ${L}.objs.length === 0) ${L}.f64[${L}.len++] = ${split.num}; else ${L}.pushSlow(${split.any});\n`;
            }
        }
        src += this.markListChanged(L);
        return src;
    }

    // ------------------------------------------------------------------ statements (shared)

    /**
     * Emit a statement that contains no yield points (structured JS).
     * @param {*} block stack block
     */
    descendStackedBlock (block) {
        const node = block.inputs;
        switch (block.opcode) {
        case StackOpcode.CONTROL_CLONE_CREATE:
            this.src += this.flushAllStatement();
            this.src += `runtime.ext_scratch3_control._createClone(${this.descendInput(node.target)}, target);\n`;
            break;
        case StackOpcode.CONTROL_CLONE_DELETE:
            this.src += 'if (!target.isOriginal) {\n';
            this.src += this.exitFlush();
            this.src += '  runtime.disposeTarget(target);\n';
            this.src += '  runtime.stopForTarget(target);\n';
            this.retire();
            this.src += '}\n';
            break;
        case StackOpcode.CONTROL_FOR: {
            const chunked = this.chunkTop;
            this.chunkTop = false;
            this.emitMaybeVersionedLoop(block, () => {
                const assigned = this.assignedVariables(block);
                const saved = new Map(this.castCache);
                this.invalidateCasts(assigned);
                const i = this.numTemp();
                if (chunked) {
                    const budget = this.numTemp();
                    this.src += `${i} = B.c; ${budget} = B.k; if (B.k < ${CHUNK_ITERATIONS}) B.k *= 2;\nfor (;;) {\n`;
                    this.src += this.chunkBudgetCheck(budget, `B.c = ${i}; `);
                    this.src += `if (!(${i} < ${this.descendInput(node.count)})) break;\n${i}++;\n`;
                    this.src += this.writeVariable(node.variable, i);
                    this.descendSubstack(node.do, new Frame(true));
                    this.src += '}\n';
                    this.castCache = saved;
                    return;
                }
                this.src += `${i} = 0; while (${i} < ${this.descendInput(node.count)}) { ${i}++; `;
                this.src += this.writeVariable(node.variable, i);
                this.descendSubstack(node.do, new Frame(true));
                this.src += '}\n';
                this.castCache = saved;
            });
            break;
        }
        case StackOpcode.CONTROL_IF_ELSE:
            this.src += `if (${this.descendInput(node.condition)}) {\n`;
            this.descendSubstack(node.whenTrue, new Frame(false));
            if (node.whenFalse.blocks.length) {
                this.src += `} else {\n`;
                this.descendSubstack(node.whenFalse, new Frame(false));
            }
            this.src += `}\n`;
            break;
        case StackOpcode.CONTROL_REPEAT: {
            const chunked = this.chunkTop;
            this.chunkTop = false;
            this.emitMaybeVersionedLoop(block, () => {
                const i = this.numTemp();
                const cond = node.times.isAlwaysType(InputType.NUMBER_INT | InputType.NUMBER_INF) ? `${i} > 0` : `${i} >= 0.5`;
                if (chunked) {
                    const budget = this.numTemp();
                    this.src += `${budget} = B.k; if (B.k < ${CHUNK_ITERATIONS}) B.k *= 2;\n${i} = B.c;\n`;
                    this.emitRangeVersions(block, i, () => {
                        this.src += `for (; ${cond}; ${i}--) {\n`;
                        this.src += this.chunkBudgetCheck(budget, `B.c = ${i}; `);
                        this.descendSubstack(node.do, new Frame(true), this.assignedVariables(block));
                        this.src += `}\n`;
                    });
                    return;
                }
                this.src += `${i} = ${this.descendInput(node.times)};\n`;
                this.emitRangeVersions(block, i, () => {
                    this.src += `for (; ${cond}; ${i}--) {\n`;
                    this.descendSubstack(node.do, new Frame(true), this.assignedVariables(block));
                    this.src += `}\n`;
                });
            });
            break;
        }
        case StackOpcode.CONTROL_STOP_ALL:
            this.src += this.exitFlush();
            this.src += 'runtime.stopAll();\n';
            this.retire();
            break;
        case StackOpcode.CONTROL_STOP_OTHERS:
            this.src += 'runtime.stopForTarget(target, th);\n';
            break;
        case StackOpcode.CONTROL_STOP_SCRIPT:
            this.stopScript();
            break;
        case StackOpcode.CONTROL_WHILE: {
            const chunked = this.chunkTop;
            this.chunkTop = false;
            this.emitMaybeVersionedLoop(block, () => {
                if (this.resumable) {
                    this.src += `while (${this.descendInput(node.condition)}) {\n`;
                    this.descendStack(node.do, new Frame(true));
                    this.src += `}\n`;
                    return;
                }
                const saved = new Map(this.castCache);
                this.invalidateCasts(this.assignedVariables(block));
                // Casts used by the condition are computed with it, then shared with the body.
                const casts = this.hoistCasts([node.condition]);
                const cond = this.descendInput(node.condition);
                const fullCond = casts.length ? `(${casts.join(', ')}, ${cond})` : cond;
                if (chunked) {
                    const budget = this.numTemp();
                    this.src += `${budget} = B.k; if (B.k < ${CHUNK_ITERATIONS}) B.k *= 2;\nfor (;;) {\n`;
                    this.src += this.chunkBudgetCheck(budget, '');
                    this.src += `if (!${fullCond}) break;\n`;
                } else {
                    this.src += `while (${fullCond}) {\n`;
                }
                this.descendSubstack(node.do, new Frame(true));
                this.src += `}\n`;
                this.castCache = saved;
            });
            break;
        }
        case StackOpcode.CONTROL_CLEAR_COUNTER:
            this.src += 'runtime.ext_scratch3_control._counter = 0;\n';
            break;
        case StackOpcode.CONTORL_INCR_COUNTER:
            this.src += 'runtime.ext_scratch3_control._counter++;\n';
            break;

        case StackOpcode.EVENT_BROADCAST:
            {
                const handle = this.m.broadcastHandle(node.broadcast);
                if (handle === null) this.src += `broadcast(runtime, ${this.descendInput(node.broadcast)});\n`;
                else this.src += `broadcastH(${handle});\n`;
            }
            break;

        case StackOpcode.LIST_ADD:
            this.src += this.listAdd(node);
            break;
        case StackOpcode.LIST_DELETE:
            this.src += `${this.listRef(node.list)}.deleteSlow(${this.descendInput(node.index)});\n`;
            break;
        case StackOpcode.LIST_DELETE_ALL:
            this.src += `${this.listRef(node.list)}.clear();\n`;
            break;
        case StackOpcode.LIST_HIDE:
            this.src += `runtime.monitorBlocks.changeBlock({ id: ${str(node.list.id)}, element: "checkbox", value: false }, runtime);\n`;
            break;
        case StackOpcode.LIST_INSERT: {
            const L = this.listRef(node.list);
            const index = this.descendInput(node.index);
            const item = this.descendInput(node.item);
            this.src += `${L}.insertSlow(${index}, ${item});\n`;
            break;
        }
        case StackOpcode.LIST_REPLACE:
            this.src += this.listReplace(node);
            break;
        case StackOpcode.LIST_SHOW:
            this.src += `runtime.monitorBlocks.changeBlock({ id: ${str(node.list.id)}, element: "checkbox", value: true }, runtime);\n`;
            break;

        case StackOpcode.LOOKS_LAYER_BACKWARD:
            if (!this.target.isStage) {
                this.src += `target.goBackwardLayers(${this.descendInput(node.layers)});\n`;
            }
            break;
        case StackOpcode.LOOKS_EFFECT_CLEAR:
            this.src += 'target.clearEffects();\n';
            break;
        case StackOpcode.LOOKS_EFFECT_CHANGE:
            if (Object.prototype.hasOwnProperty.call(this.target.effects, node.effect)) {
                this.src += `target.setEffect(${str(node.effect)}, runtime.ext_scratch3_looks.clampEffect(${str(node.effect)}, ${this.descendInput(node.value)} + target.effects[${str(node.effect)}]));\n`;
            }
            break;
        case StackOpcode.LOOKS_SIZE_CHANGE:
            this.src += `target.setSize(target.size + ${this.descendInput(node.size)});\n`;
            break;
        case StackOpcode.LOOKS_LAYER_FORWARD:
            if (!this.target.isStage) {
                this.src += `target.goForwardLayers(${this.descendInput(node.layers)});\n`;
            }
            break;
        case StackOpcode.LOOKS_LAYER_BACK:
            if (!this.target.isStage) {
                this.src += 'target.goToBack();\n';
            }
            break;
        case StackOpcode.LOOKS_LAYER_FRONT:
            if (!this.target.isStage) {
                this.src += 'target.goToFront();\n';
            }
            break;
        case StackOpcode.LOOKS_HIDE:
            this.src += 'target.setVisible(false);\n';
            this.src += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case StackOpcode.LOOKS_BACKDROP_NEXT:
            this.src += 'runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1, true);\n';
            break;
        case StackOpcode.LOOKS_COSTUME_NEXT:
            this.src += 'target.setCostume(target.currentCostume + 1);\n';
            break;
        case StackOpcode.LOOKS_EFFECT_SET:
            if (Object.prototype.hasOwnProperty.call(this.target.effects, node.effect)) {
                this.src += `target.setEffect(${str(node.effect)}, runtime.ext_scratch3_looks.clampEffect(${str(node.effect)}, ${this.descendInput(node.value)}));\n`;
            }
            break;
        case StackOpcode.LOOKS_SIZE_SET:
            this.src += `target.setSize(${this.descendInput(node.size)});\n`;
            break;
        case StackOpcode.LOOKS_SHOW:
            this.src += 'target.setVisible(true);\n';
            this.src += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case StackOpcode.LOOKS_BACKDROP_SET:
            this.src += `runtime.ext_scratch3_looks._setBackdrop(stage, ${this.descendInput(node.backdrop)});\n`;
            break;
        case StackOpcode.LOOKS_COSTUME_SET:
            this.src += `runtime.ext_scratch3_looks._setCostume(target, ${this.descendInput(node.costume)});\n`;
            break;
        case StackOpcode.LOOKS_SAY:
            this.src += `runtime.ext_scratch3_looks._say(${this.descendInput(node.message)}, target);\n`;
            break;
        case StackOpcode.LOOKS_THINK:
            this.src += `runtime.ext_scratch3_looks._think(${this.descendInput(node.message)}, target);\n`;
            break;

        case StackOpcode.MOTION_X_CHANGE:
            this.src += `target.setXY(target.x + ${this.descendInput(node.dx)}, target.y);\n`;
            break;
        case StackOpcode.MOTION_Y_CHANGE:
            this.src += `target.setXY(target.x, target.y + ${this.descendInput(node.dy)});\n`;
            break;
        case StackOpcode.MOTION_IF_ON_EDGE_BOUNCE:
            this.src += `runtime.ext_scratch3_motion._ifOnEdgeBounce(target);\n`;
            break;
        case StackOpcode.MOTION_DIRECTION_SET:
            this.src += `target.setDirection(${this.descendInput(node.direction)});\n`;
            break;
        case StackOpcode.MOTION_ROTATION_STYLE_SET:
            this.src += `target.setRotationStyle(${str(node.style)});\n`;
            break;
        case StackOpcode.MOTION_X_SET: // fallthrough
        case StackOpcode.MOTION_Y_SET: // fallthrough
        case StackOpcode.MOTION_XY_SET: {
            this.descendedIntoModulo = false;
            const x = 'x' in node ? this.descendInput(node.x) : 'target.x';
            const y = 'y' in node ? this.descendInput(node.y) : 'target.y';
            this.src += `target.setXY(${x}, ${y});\n`;
            if (this.descendedIntoModulo) {
                this.src += `if (target.interpolationData) target.interpolationData = null;\n`;
            }
            break;
        }
        case StackOpcode.MOTION_STEP:
            this.src += `runtime.ext_scratch3_motion._moveSteps(${this.descendInput(node.steps)}, target);\n`;
            break;

        case StackOpcode.NOP:
            break;

        case StackOpcode.PEN_CLEAR:
            this.src += `${PEN_EXT}.clear();\n`;
            break;
        case StackOpcode.PEN_DOWN:
            this.src += `${PEN_EXT}._penDown(target);\n`;
            break;
        case StackOpcode.PEN_COLOR_PARAM_CHANGE:
            this.src += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param)}, ${this.descendInput(node.value)}, ${PEN_STATE}, true);\n`;
            break;
        case StackOpcode.PEN_SIZE_CHANGE:
            this.src += `${PEN_EXT}._changePenSizeBy(${this.descendInput(node.size)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_HUE_CHANGE_LEGACY:
            this.src += `${PEN_EXT}._changePenHueBy(${this.descendInput(node.hue)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SHADE_CHANGE_LEGACY:
            this.src += `${PEN_EXT}._changePenShadeBy(${this.descendInput(node.shade)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_HUE_SET_LEGACY:
            this.src += `${PEN_EXT}._setPenHueToNumber(${this.descendInput(node.hue)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SHADE_SET_LEGACY:
            this.src += `${PEN_EXT}._setPenShadeToNumber(${this.descendInput(node.shade)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SET:
            this.src += `${PEN_EXT}._setPenColorToColor(${this.descendInput(node.color)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_PARAM_SET:
            this.src += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param)}, ${this.descendInput(node.value)}, ${PEN_STATE}, false);\n`;
            break;
        case StackOpcode.PEN_SIZE_SET:
            this.src += `${PEN_EXT}._setPenSizeTo(${this.descendInput(node.size)}, target);\n`;
            break;
        case StackOpcode.PEN_STAMP:
            this.src += `${PEN_EXT}._stamp(target);\n`;
            break;
        case StackOpcode.PEN_UP:
            this.src += `${PEN_EXT}._penUp(target);\n`;
            break;

        case StackOpcode.PROCEDURE_CALL: {
            if (this.isEmptyCall(node)) {
                // TODO still need to evaluate arguments (same as TW)
                break;
            }
            const callee = this.calleeOf(node.variant);
            if (callee.kind === 'resumable') throw new Error('TTW: resumable call in structured code');
            const args = node.arguments.map(arg => this.descendInput(arg));
            this.src += `${this.nativeCallExpression(callee, args)};\n`;
            break;
        }
        case StackOpcode.PROCEDURE_RETURN:
            this.stopScriptAndReturn(this.descendInput(node.value));
            break;

        case StackOpcode.SENSING_TIMER_RESET:
            this.src += 'runtime.ioDevices.clock.resetProjectTimer();\n';
            break;

        case StackOpcode.DEBUGGER:
            this.src += this.flushAllStatement();
            this.src += 'debugger;\n';
            break;

        case StackOpcode.VAR_HIDE:
            this.src += `runtime.monitorBlocks.changeBlock({ id: ${str(node.variable.id)}, element: "checkbox", value: false }, runtime);\n`;
            break;
        case StackOpcode.VAR_SET:
            this.src += this.writeVariable(node.variable, this.descendInput(node.value));
            break;
        case StackOpcode.VAR_SHOW:
            this.src += `runtime.monitorBlocks.changeBlock({ id: ${str(node.variable.id)}, element: "checkbox", value: true }, runtime);\n`;
            break;

        case 'ttw.inline': {
            // Inlined procedure (02 §5): arguments in temporaries, return = break out of the labelled block.
            const numericOnly = this.numericOnlyTemps(node);
            for (let k = 0; k < node.args.length; k++) {
                this.extraLocals.add(node.temps[k]);
                if (numericOnly.has(node.temps[k])) {
                    // Every use converts the argument to a number: convert once, here. The temporary then
                    // holds a JS number on every path instead of "number or string".
                    this.numericRaw.add(node.temps[k]);
                    this.src += `${node.temps[k]} = ${this.descendInput(node.args[k].toType(InputType.NUMBER))};\n`;
                } else {
                    this.src += `${node.temps[k]} = ${this.descendInput(node.args[k])};\n`;
                }
            }
            this.src += `${node.label}: {\n`;
            this.descendSubstack(node.body, new Frame(false));
            this.src += '}\n';
            break;
        }
        case 'ttw.inlineReturn':
            if (node.value) {
                const t = this.anyTemp();
                this.src += `${t} = ${this.descendInput(node.value)};\n`;
            }
            this.src += `break ${node.label};\n`;
            break;

        case StackOpcode.VISUAL_REPORT: {
            const value = this.anyTemp();
            this.src += `${value} = ${this.descendInput(node.input)};\n`;
            this.src += `if (${value} !== undefined) runtime.visualReport(target, ${str(this.script.topBlockId)}, ${value});\n`;
            break;
        }

        default:
            log.warn(`TTW: Unknown stacked block: ${block.opcode}`, node);
            throw new Error(`TTW: Unknown stacked block: ${block.opcode}`);
        }
    }

    /**
     * @returns {string} statement flushing every promoted variable (for flush-all points)
     */
    flushAllStatement () {
        const parts = this.flushList(null);
        return parts.length ? parts.join(';\n') + ';\n' : '';
    }

    /**
     * End the thread.
     */
    retire () {
        if (this.resumable) {
            this.src += `${this.scopedFlush()}retire(th); return 2;\n`;
        } else if (this.isProcedure) {
            this.src += `retire(th); throw RETIRE;\n`;
        } else if (this.chunkBox) {
            this.src += `retire(th); ${this.chunkSave()}return 2;\n`;
        } else {
            this.src += 'retire(th); return;\n';
        }
    }

    /**
     * @param {Array<{v: string}>} promoted promoted variables
     * @returns {string} statements storing them into the box `B`
     */
    chunkSaveFor (promoted) {
        return promoted.map(info => `B.${info.v} = ${info.v};\n`).join('');
    }

    /**
     * @returns {string} statements storing the promoted locals into the chunk box
     */
    chunkSave () {
        let src = '';
        for (const info of this.vars.values()) {
            if (info.v) src += `${this.chunkBox}.${info.v} = ${info.v}; `;
        }
        return src;
    }

    stopScript () {
        if (this.isProcedure) {
            this.returnFromProcedure('""');
        } else if (this.resumable) {
            this.src += `${this.scopedFlush()}return 2;\n`;
        } else if (this.chunkBox) {
            this.src += `${this.chunkSave()}return 2;\n`;
        } else {
            this.src += this.exitFlush();
            this.src += 'return;\n';
        }
    }

    /**
     * @param {string} valueJS value to return
     */
    stopScriptAndReturn (valueJS) {
        if (this.isProcedure) {
            this.returnFromProcedure(valueJS);
        } else if (this.resumable) {
            this.src += `${this.scopedFlush()}return 2;\n`;
        } else if (this.chunkBox) {
            this.src += `${this.chunkSave()}return 2;\n`;
        } else {
            this.src += this.exitFlush();
            this.src += 'return;\n';
        }
    }

    /**
     * @param {string} valueJS value to return
     */
    returnFromProcedure (valueJS) {
        if (this.resumable) {
            const flush = this.scopedFlush();
            if (flush) {
                const t = this.anyTemp();
                this.src += `${t} = ${valueJS}; ${flush}th.ret = ${t}; th.frame = fr.parent; th.fn = fr.parent.fnRef; return 1;\n`;
                return;
            }
            this.src += `th.ret = ${valueJS}; th.frame = fr.parent; th.fn = fr.parent.fnRef; return 1;\n`;
            return;
        }
        if (this.chunkBox) {
            // The caller of the chunk function flushes and returns.
            this.src += `${this.chunkBox}.r = ${valueJS}; ${this.chunkSave()}return 2;\n`;
            return;
        }
        const flush = this.exitFlush();
        if (!flush) {
            this.src += `return ${valueJS};\n`;
            return;
        }
        if (SIMPLE_EXPRESSION.test(valueJS)) {
            this.src += `${flush}return ${valueJS};\n`;
            return;
        }
        const t = this.anyTemp();
        this.src += `${t} = ${valueJS};\n${flush}return ${t};\n`;
    }

    /**
     * @param {IntermediateStack} stack stack
     * @param {Frame} frame frame
     */
    descendStack (stack, frame) {
        this.stackDepth++;
        this.frames.push(frame);
        const parentSamplerLocation = this.currentSamplerLocation;
        for (let i = 0; i < stack.blocks.length; i++) {
            frame.isLastBlock = i === stack.blocks.length - 1;
            const block = stack.blocks[i];
            this.sample(block);
            if (this.resumable) {
                this.resumableBlock(block);
            } else {
                this.nativeBlock(block);
            }
        }
        if (this.m.sampler && frame.isLoop) {
            this.src += `pc[0] = ${parentSamplerLocation};\n`;
        }
        this.currentSamplerLocation = parentSamplerLocation;
        this.frames.pop();
        this.stackDepth--;
    }

    /**
     * @param {*} block stack block
     */
    sample (block) {
        const sampler = this.m.sampler;
        if (sampler && block.blockId) {
            const originalTargetId = this.target.sprite.clones[0].id;
            this.currentSamplerLocation = sampler.blockToLocation(originalTargetId, block.blockId);
            this.src += `pc[0] = ${this.currentSamplerLocation};\n`;
        }
    }

    /**
     * @returns {Frame|null} innermost loop frame if the current block is the last command of that loop
     */
    lastBlockInLoop () {
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const frame = this.frames[i];
            if (!frame.isLastBlock) {
                return null;
            }
            if (frame.isLoop) {
                return frame;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ resumable statements (05 §2)

    /**
     * Code that ends a loop iteration and goes back to the loop head (yielding as TW's yieldLoop would).
     * @param {number} head loop head label
     * @param {boolean} yields whether the loop yields at the end of each iteration
     * @param {boolean} stuckOnly yield only when stuck (warp timer)
     * @param {string} save statements saving loop state before a yield
     * @param {boolean} structured true when inside a structured JS loop (continue the JS loop instead)
     * @returns {string} code
     */
    loopTail (head, yields, stuckOnly, save, structured) {
        if (!yields) {
            return structured ? '' : `fr.pc = ${head}; continue;\n`;
        }
        if (stuckOnly) {
            let y = `if (${this.stuckFn()}()) { ${save}fr.pc = ${head}; return 0; }\n`;
            if (structured && this.helperBudget) {
                // Loop helper: return to the step function every so often so V8 optimizes the helper
                // through normal calls rather than OSR (07 §5).
                y += `if (--${this.helperBudget} === 0) { ${save}fr.pc = ${head}; return -2; }\n`;
            }
            return structured ? y : `${y}fr.pc = ${head}; continue;\n`;
        }
        return `${save}fr.pc = ${head}; return 0;\n`;
    }

    /**
     * @param {*} block loop block
     * @returns {{yields: boolean, stuckOnly: boolean}} how the loop yields (TW yieldLoop / yieldStuckOrNotWarp)
     */
    loopYieldKind (block) {
        if (!block.yields) return {yields: false, stuckOnly: false};
        const usesStuckOrNotWarp = block.opcode === StackOpcode.CONTROL_WHILE && block.inputs.warpTimer ? true : this.warpTimer;
        if (usesStuckOrNotWarp) {
            return {yields: true, stuckOnly: this.isWarp};
        }
        // yieldNotWarp
        return {yields: !this.isWarp, stuckOnly: false};
    }

    /**
     * Resumable units: promote the variables of a structured loop that only yields at its end when stuck
     * (warp timer). They are loaded every time the loop is (re)entered and flushed before every yield, exit,
     * call and flush-all point, exactly like a native unit (04 §1, §3; 05 §3).
     * @param {*} block loop block
     * @param {boolean} enabled whether to promote
     * @returns {string} code loading the promoted variables (emitted at the loop head)
     */
    beginScopedPromotion (block, enabled) {
        this.scopedVars = [];
        if (!enabled || !this.resumable || this.m.runtime.compilerOptions.ttwScopedPromotion === false) return '';
        const seen = new Set();
        const note = (variable, written) => {
            if (variable.isCloud) return;
            const info = this.varInfo(variable);
            if (written) info.written = true;
            if (!seen.has(info)) {
                seen.add(info);
                info.v = `v${info.h.substring(1)}`;
                this.scopedLocals.add(info.v);
                this.scopedVars.push(info);
            }
        };
        walkStack(new IntermediateStack([block]), {
            block: b => {
                if (b.opcode === StackOpcode.VAR_SET || b.opcode === StackOpcode.CONTROL_FOR) note(b.inputs.variable, true);
            },
            input: input => {
                if (input.opcode === InputOpcode.VAR_GET) note(input.inputs.variable, false);
            }
        });
        return this.scopedVars.map(info => `${info.v} = ${info.h}.value;\n`).join('');
    }

    /**
     * Resumable units: emit a structured loop that only yields when stuck (warp timer) as a separate helper
     * function, so the hot loop isn't inside the step function's `switch` (much slower in some V8 versions).
     * The helper returns -1 when the loop completes; anything else is the step function's result.
     * @param {boolean} enabled whether to use a helper
     * @param {() => void} emit emits the loop
     */
    emitLoopHelper (enabled, emit) {
        if (!enabled || this.m.runtime.compilerOptions.ttwLoopHelpers === false) {
            emit();
            return;
        }
        const name = `${this.fnName}$l${this.loopHelpers.length}`;
        const savedSrc = this.src;
        const budget = this.numTemp();
        this.src = `${budget} = ${CHUNK_ITERATIONS};\n`;
        this.helperBudget = budget;
        emit();
        this.helperBudget = null;
        this.loopHelpers.push({name, body: this.src});
        this.src = savedSrc;
        const r = this.numTemp();
        // -1: loop done; -2: budget used up (fr.pc is the loop head), call again; otherwise a step result.
        this.src += `if ((${r} = ${name}(th, fr)) !== -1) { if (${r} === -2) continue; return ${r}; }\n`;
    }

    /**
     * @returns {string} statements flushing the scoped promoted variables
     */
    scopedFlush () {
        return (this.scopedVars || []).filter(info => info.written)
            .map(info => `${info.h}.value = ${info.v}; `)
            .join('');
    }

    endScopedPromotion () {
        const flush = this.scopedFlush();
        if (flush) this.src += `${flush}\n`;
        for (const info of this.scopedVars || []) {
            info.v = null;
            info.written = false;
        }
        this.scopedVars = [];
    }

    /**
     * Spill the yielding inputs of a block (in evaluation order).
     * @param {*} block stack block
     */
    spillBlockInputs (block) {
        this.spillChildren(block.inputs);
    }

    /**
     * Emit one block of a resumable unit.
     * @param {*} block stack block
     */
    resumableBlock (block) {
        if (!this.blockYields(block)) {
            this.descendStackedBlock(block);
            return;
        }
        const node = block.inputs;
        switch (block.opcode) {
        case StackOpcode.CONTROL_IF_ELSE: {
            const cond = this.descendInput(this.spill(node.condition));
            const elseLabel = this.label();
            const end = this.label();
            this.src += `if (!${cond}) { fr.pc = ${elseLabel}; continue; }\n`;
            this.descendStack(node.whenTrue, new Frame(false));
            this.src += `fr.pc = ${end}; continue;\ncase ${elseLabel}:\n`;
            this.descendStack(node.whenFalse, new Frame(false));
            this.src += `case ${end}:\n`;
            break;
        }
        case StackOpcode.CONTROL_REPEAT: {
            const {yields, stuckOnly} = this.loopYieldKind(block);
            const count = this.slot();
            const intCount = node.times.isAlwaysType(InputType.NUMBER_INT | InputType.NUMBER_INF);
            this.src += `${count} = ${this.descendInput(this.spill(node.times))};\n`;
            const head = this.label();
            if (!this.stackYields(node.do)) {
                const c = this.numTemp();
                this.src += `case ${head}:\n`;
                this.emitLoopHelper(yields && stuckOnly, () => {
                    const scope = this.beginScopedPromotion(block, yields && stuckOnly);
                    this.src += `${scope}for (${c} = ${count}; ${intCount ? `${c} > 0` : `${c} >= 0.5`}; ${c}--) {\n`;
                    this.descendStack(node.do, new Frame(true, head));
                    this.src += this.loopTail(head, yields, stuckOnly, `${count} = ${c} - 1; ${this.scopedFlush()}`, true);
                    this.src += '}\n';
                    this.endScopedPromotion();
                });
            } else {
                const end = this.label();
                this.src += `case ${head}:\nif (!(${intCount ? `${count} > 0` : `${count} >= 0.5`})) { fr.pc = ${end}; continue; }\n${count}--;\n`;
                this.descendStack(node.do, new Frame(true, head));
                this.src += this.loopTail(head, yields, stuckOnly, '', false);
                this.src += `case ${end}:\n`;
            }
            break;
        }
        case StackOpcode.CONTROL_WHILE: {
            const {yields, stuckOnly} = this.loopYieldKind(block);
            const head = this.label();
            this.src += `case ${head}:\n`;
            if (!this.stackYields(node.do) && !this.inputYields(node.condition)) {
                this.emitLoopHelper(yields && stuckOnly, () => {
                    this.src += this.beginScopedPromotion(block, yields && stuckOnly);
                    this.src += `while (${this.descendInput(node.condition)}) {\n`;
                    this.descendStack(node.do, new Frame(true, head));
                    this.src += this.loopTail(head, yields, stuckOnly, this.scopedFlush(), true);
                    this.src += '}\n';
                    this.endScopedPromotion();
                });
            } else {
                const end = this.label();
                const cond = this.descendInput(this.spill(node.condition));
                this.src += `if (!${cond}) { fr.pc = ${end}; continue; }\n`;
                this.descendStack(node.do, new Frame(true, head));
                this.src += this.loopTail(head, yields, stuckOnly, '', false);
                this.src += `case ${end}:\n`;
            }
            break;
        }
        case StackOpcode.CONTROL_FOR: {
            const {yields, stuckOnly} = this.loopYieldKind(block);
            const index = this.slot();
            this.src += `${index} = 0;\n`;
            const head = this.label();
            this.src += `case ${head}:\n`;
            if (!this.stackYields(node.do) && !this.inputYields(node.count)) {
                this.emitLoopHelper(yields && stuckOnly, () => {
                    this.src += this.beginScopedPromotion(block, yields && stuckOnly);
                    this.src += `while (${index} < ${this.descendInput(node.count)}) {\n${index}++;\n`;
                    this.src += this.writeVariable(node.variable, index);
                    this.descendStack(node.do, new Frame(true, head));
                    this.src += this.loopTail(head, yields, stuckOnly, this.scopedFlush(), true);
                    this.src += '}\n';
                    this.endScopedPromotion();
                });
            } else {
                const end = this.label();
                const count = this.descendInput(this.spill(node.count));
                this.src += `if (!(${index} < ${count})) { fr.pc = ${end}; continue; }\n${index}++;\n`;
                this.src += this.writeVariable(node.variable, index);
                this.descendStack(node.do, new Frame(true, head));
                this.src += this.loopTail(head, yields, stuckOnly, '', false);
                this.src += `case ${end}:\n`;
            }
            break;
        }
        case StackOpcode.CONTROL_WAIT: {
            const timerSlot = this.slot();
            const duration = this.slot();
            const seconds = this.descendInput(this.spill(node.seconds));
            this.src += `${timerSlot} = timer(runtime);\n`;
            this.src += `${duration} = Math.max(0, 1000 * ${seconds});\n`;
            this.src += 'runtime.requestRedraw();\n';
            const wait = this.label();
            if (!this.isWarp) {
                // always yield at least once, even on 0 second durations
                this.src += `fr.pc = ${wait}; return 0;\n`;
            }
            this.src += `case ${wait}:\n`;
            this.src += `while (${timerSlot}.timeElapsed() < ${duration}) {\n`;
            this.src += this.isWarp ? `if (${this.stuckFn()}()) { fr.pc = ${wait}; return 0; }\n` : `fr.pc = ${wait}; return 0;\n`;
            this.src += '}\n';
            this.src += `${timerSlot} = null;\n`;
            break;
        }
        case StackOpcode.CONTROL_WAIT_UNTIL: {
            const head = this.label();
            this.src += `case ${head}:\n`;
            if (!this.inputYields(node.condition)) {
                this.src += `while (!${this.descendInput(node.condition)}) {\n`;
                this.src += this.isWarp ? `if (${this.stuckFn()}()) { fr.pc = ${head}; return 0; }\n` : `fr.pc = ${head}; return 0;\n`;
                this.src += '}\n';
            } else {
                const cond = this.descendInput(this.spill(node.condition));
                this.src += `if (!${cond}) {\n`;
                this.src += this.isWarp ? `if (${this.stuckFn()}()) { fr.pc = ${head}; return 0; }\nfr.pc = ${head}; continue;\n` : `fr.pc = ${head}; return 0;\n`;
                this.src += '}\n';
            }
            break;
        }
        case StackOpcode.EVENT_BROADCAST_AND_WAIT: {
            const threads = this.slot();
            const handle = this.m.broadcastHandle(node.broadcast);
            if (handle === null) {
                const name = this.descendInput(this.spill(node.broadcast));
                this.src += `${threads} = broadcast(runtime, ${name});\n`;
            } else {
                this.src += `${threads} = broadcastH(${handle});\n`;
            }
            const wait = this.label();
            this.src += `case ${wait}:\nif (waitThreads(th, ${threads})) { fr.pc = ${wait}; return 0; }\n${threads} = null;\n`;
            break;
        }
        case StackOpcode.HAT_EDGE: {
            this.isInHat = true;
            const cond = this.descendInput(this.spill(node.condition));
            this.isInHat = false;
            const v = this.anyTemp();
            const has = this.anyTemp();
            const old = this.anyTemp();
            // For exact Scratch parity, evaluate the input before checking old edge state.
            this.src += `${v} = ${cond};\n`;
            this.src += `${has} = target.hasEdgeActivatedValue(${str(node.id)});\n`;
            this.src += `${old} = target.updateEdgeActivatedValue(${str(node.id)}, ${v});\n`;
            this.src += `if (!(${has} ? (!${old} && ${v}) : ${v})) return 2;\n`;
            const next = this.label();
            this.src += `fr.pc = ${next}; return 0;\ncase ${next}:\n`;
            break;
        }
        case StackOpcode.HAT_PREDICATE: {
            this.isInHat = true;
            const cond = this.descendInput(this.spill(node.condition));
            this.isInHat = false;
            this.src += `if (!${cond}) return 2;\n`;
            const next = this.label();
            this.src += `fr.pc = ${next}; return 0;\ncase ${next}:\n`;
            break;
        }
        case StackOpcode.COMPATIBILITY_LAYER: {
            const loopFrame = this.lastBlockInLoop();
            const blockType = node.blockType;
            if (blockType === BlockType.COMMAND || blockType === BlockType.HAT) {
                this.spillChildren(node);
                this.emitCompatibilityLayerCall(node, !!loopFrame, null, null, loopFrame);
            } else if (blockType === BlockType.CONDITIONAL || blockType === BlockType.LOOP) {
                this.emitBranchingCompatibilityLayerCall(node, blockType === BlockType.LOOP);
            } else {
                throw new Error(`Unknown block type: ${blockType}`);
            }
            break;
        }
        case StackOpcode.ADDON_CALL:
            this.spillChildren(node);
            this.emitAddonCall(node, null);
            break;
        case StackOpcode.PROCEDURE_CALL: {
            const callee = this.calleeOf(node.variant);
            const yieldForRecursion = !this.isWarp && node.code === this.script.procedureCode;
            if (yieldForRecursion) {
                // TW: yield, then evaluate the arguments and call.
                const y = this.label();
                this.src += `fr.pc = ${y}; return 0;\ncase ${y}:\n`;
            }
            if (callee.kind === 'resumable') {
                const args = this.captureAll(node.arguments);
                this.emitResumableCall(callee, args);
            } else {
                this.spillChildren(node);
                const args = node.arguments.map(arg => this.descendInput(arg));
                this.src += `${this.nativeCallExpression(callee, args)};\n`;
            }
            break;
        }
        default:
            // A simple block with yielding inputs (eg. say (compat reporter)).
            this.spillBlockInputs(block);
            this.descendStackedBlock(block);
            break;
        }
    }

    /**
     * Push a frame for a resumable callee and switch to it (05 §1).
     * @param {import('./program').Unit} callee callee
     * @param {string[]} args evaluated arguments
     */
    emitResumableCall (callee, args) {
        const names = this.m.namesOf(callee);
        const k = this.label();
        this.src += `{ const nf = new ${names.frame}(fr);${args.map((a, i) => ` nf.s${i} = ${a};`).join('')} th.frame = nf; th.fn = ${names.fn}; }\n`;
        this.src += `fr.pc = ${k}; return 1;\ncase ${k}:\n`;
    }

    /**
     * @param {*} node compat node (inputs already spilled)
     * @returns {string} inputs object literal
     */
    compatInputsObject (node) {
        let result = '{';
        for (const inputName of Object.keys(node.inputs)) {
            result += `${str(inputName)}:${this.descendInput(node.inputs[inputName])},`;
        }
        for (const fieldName of Object.keys(node.fields)) {
            result += `${str(fieldName)}:${str(node.fields[fieldName])},`;
        }
        result += '}';
        return result;
    }

    /**
     * Emit the states of one compatibility layer call (05 §5).
     * @param {*} node compat node (inputs already spilled)
     * @param {boolean} setFlags whether this is the last command of a loop (skip the loop yield after a promise)
     * @param {string|null} branchInfo slot holding branch info, if any
     * @param {string|null} resultSlot slot to store the result into, if any
     * @param {Frame|null} [loopFrame] loop frame when setFlags
     */
    emitCompatibilityLayerCall (node, setFlags, branchInfo, resultSlot, loopFrame = null) {
        const fn = this.m.opcodeFunction(node.opcode);
        this.emitCompatCallStates(this.compatInputsObject(node), fn, str(node.id), branchInfo, resultSlot, setFlags ? loopFrame : null);
    }

    /**
     * @param {*} node addon call node (inputs already spilled)
     * @param {string|null} resultSlot slot for the result
     */
    emitAddonCall (node, resultSlot) {
        let inputs = '{';
        for (const name of Object.keys(node.arguments)) {
            inputs += `${str(name)}:${this.descendInput(node.arguments[name])},`;
        }
        inputs += '}';
        this.emitCompatCallStates(inputs, `runtime.getAddonBlock(${str(node.code)}).callback`, str(node.blockId), null, resultSlot, null);
    }

    /**
     * @param {string} inputsJS inputs object literal
     * @param {string} fnJS primitive function
     * @param {string} blockIdJS block id literal
     * @param {string|null} branchInfo slot with branch info
     * @param {string|null} resultSlot slot to store the result
     * @param {Frame|null} loopFrame loop to continue without yielding after a promise (TW hasResumedFromPromise)
     */
    emitCompatCallStates (inputsJS, fnJS, blockIdJS, branchInfo, resultSlot, loopFrame) {
        const args = this.slot();
        const stackFrame = this.slot();
        const again = this.slot();
        const call = this.label();
        const resume = this.label();
        this.src += `${args} = ${inputsJS};\n`;
        this.src += `${stackFrame} = ${branchInfo ? `${branchInfo}.stackFrame` : '{}'};\n`;
        this.src += `${again} = false;\n`;
        this.src += `case ${call}:\n`;
        this.src += `switch (compatCall(th, ${args}, ${stackFrame}, ${fnJS}, ${this.isWarp ? this.stuckFn() : 'null'}, ${blockIdJS}, ${branchInfo || 'null'}, ${again})) {\n`;
        this.src += `case 1: ${again} = true; fr.pc = ${call}; return 0;\n`;
        this.src += `case 3: ${again} = true; fr.pc = ${call}; continue;\n`;
        this.src += `case 2: fr.pc = ${resume}; return 0;\n`;
        this.src += '}\n';
        this.src += `case ${resume}:\n`;
        if (resultSlot) {
            this.src += `${resultSlot} = compatResume(th, ${branchInfo || 'null'});\n`;
        } else {
            this.src += `compatResume(th, ${branchInfo || 'null'});\n`;
        }
        this.src += `${args} = null; ${stackFrame} = null;\n`;
        if (loopFrame) {
            this.src += `if (th.fromPromise) { th.fromPromise = false; fr.pc = ${loopFrame.head}; continue; }\n`;
        }
    }

    /**
     * CONDITIONAL / LOOP blocks in the compatibility layer.
     * @param {*} node compat node
     * @param {boolean} isLoop default loop flag
     */
    emitBranchingCompatibilityLayerCall (node, isLoop) {
        const branchInfo = this.slot();
        const result = this.slot();
        this.src += `${branchInfo} = createBranchInfo(${isLoop});\n`;
        const head = this.label();
        const end = this.label();
        const afterSwitch = this.label();
        this.src += `case ${head}:\n`;
        // Inputs are re-evaluated every time the block runs, as in TW.
        const savedInputs = Object.assign({}, node.inputs);
        this.spillChildren(node);
        this.emitCompatibilityLayerCall(node, false, branchInfo, result);
        Object.assign(node.inputs, savedInputs);
        this.src += `${branchInfo}.branch = +${result};\n`;
        this.src += `if (!${branchInfo}.branch) { fr.pc = ${end}; continue; }\n`;
        const branchLabels = [];
        for (const index in node.substacks) {
            const l = this.label();
            branchLabels.push([+index, l]);
            this.src += `if (${branchInfo}.branch === ${+index}) { fr.pc = ${l}; continue; }\n`;
        }
        this.src += `fr.pc = ${afterSwitch}; continue;\n`;
        const keys = Object.keys(node.substacks);
        for (let i = 0; i < keys.length; i++) {
            this.src += `case ${branchLabels[i][1]}:\n`;
            this.descendStack(node.substacks[keys[i]], new Frame(false));
            this.src += `fr.pc = ${afterSwitch}; continue;\n`;
        }
        this.src += `case ${afterSwitch}:\n`;
        this.src += `if (!${branchInfo}.isLoop) { fr.pc = ${end}; continue; }\n`;
        const yields = this.warpTimer ? {yields: true, stuckOnly: this.isWarp} : {yields: !this.isWarp, stuckOnly: false};
        this.src += this.loopTail(head, yields.yields, yields.stuckOnly, '', false);
        this.src += `case ${end}:\n`;
    }

    // ------------------------------------------------------------------ functions

    /**
     * @returns {string} JS of this unit (function declaration, plus frame class for resumable units)
     */
    compile () {
        const names = this.m.namesOf(this.unit);
        const stack = this.script.stack;
        this.src = '';
        if (this.resumable) {
            this.src += 'case 0:\n';
            if (stack) this.descendStack(stack, new Frame(false));
            if (this.isProcedure) {
                this.returnFromProcedure('""');
            } else {
                this.src += 'return 2;\n';
            }
        } else if (this.split && stack) {
            this.emitSplitParts(stack);
            this.src += this.exitFlush();
            if (this.isProcedure) this.src += 'return "";\n';
        } else {
            if (stack) this.descendStack(stack, new Frame(false));
            if (this.isProcedure) {
                this.returnFromProcedure('""');
            } else {
                this.src += this.exitFlush();
            }
        }
        const body = this.src;

        let head = '';
        head += 'const target = S.target;\n';
        for (const info of this.vars.values()) {
            head += `const ${info.h} = ${info.home};\n`;
        }
        for (const [home, local] of this.listLocals) {
            head += `const ${local} = ${home};\n`;
        }
        const promoted = [...this.vars.values()].filter(info => info.v);
        if (promoted.length) {
            head += `let ${promoted.map(info => `${info.v} = ${info.h}.value`).join(', ')};\n`;
        }
        if (this.guards.length && this.twin) {
            // Entry type guards (04 §2): fall back to the generic twin if a program-NUM variable isn't a number.
            const conds = [];
            for (const guard of this.guards) {
                const info = this.vars.get(guard.key);
                if (!info || !info.v) continue;
                conds.push(`typeof ${info.v} !== "number"`);
                if (guard.noNaN) conds.push(`${info.v} !== ${info.v}`);
            }
            if (conds.length) {
                const args = this.script.arguments.map((_, i) => `, p${i}`).join('');
                head += `if (${conds.join(' || ')}) return ${this.twin}(th, S${args});\n`;
            }
        }
        const temps = [];
        for (let i = 0; i < this.nTemps; i++) temps.push(`n${i} = 0`);
        for (let i = 0; i < this.aTemps; i++) temps.push(`a${i}`);
        for (const local of this.extraLocals) temps.push(`${local} = 0`);
        for (const local of this.scopedLocals) temps.push(`${local} = 0`);
        if (temps.length) head += `let ${temps.join(', ')};\n`;

        let src = '';
        if (this.stuckName !== null) {
            src += `const ${this.stuckName} = makeStuck(runtime);\n`;
        }
        if (this.resumable) {
            const frame = names.frame;
            src += `class ${frame} {\nconstructor (parent) {\nthis.parent = parent;\nthis.pc = 0;\n`;
            for (let i = 0; i < this.slots; i++) src += `this.s${i} = undefined;\n`;
            src += '}\n}\n';
            src += `function ${names.fn} (th, fr) {\nconst S = th.self;\n${head}for (;;) switch (fr.pc) {\n${body}default: throw new Error("TTW: bad pc " + fr.pc);\n}\n}\n`;
            src += `${frame}.prototype.fnRef = ${names.fn};\n`;
            for (const helper of this.loopHelpers) {
                src += `function ${helper.name} (th, fr) {\nconst S = th.self;\n${head}${helper.body}return -1;\n}\n`;
            }
        } else {
            const args = [];
            for (let i = 0; i < this.script.arguments.length; i++) args.push(`, p${i}`);
            src += `function ${this.fnName} (th, S${args.join('')}) {\n${head}${body}}\n`;
            for (const part of this.parts) {
                src += `function ${part.name} (th, S${args.join('')}) {\n${head}${part.body}return CONTINUE;\n}\n`;
            }
            for (const chunk of this.chunks) {
                // Same handles and temporaries as the main function; promoted locals come from the box.
                let chunkHead = head.split('\n').filter(line => !line.startsWith('let v') && !line.startsWith('if (typeof'))
                    .join('\n');
                const loads = promoted.map(info => `${info.v} = B.${info.v}`);
                if (loads.length) chunkHead += `let ${loads.join(', ')};\n`;
                src += `function ${chunk.name} (th, S${args.join('')}, B) {\n${chunkHead}${chunk.body}${this.chunkSaveFor(promoted)}return 0;\n}\n`;
            }
        }
        return src;
    }
}

module.exports = {
    MAX_FUNCTION_NODES,
    ModuleBuilder,
    UnitEmitter,
    promotionCandidates,
    sanitize
};
