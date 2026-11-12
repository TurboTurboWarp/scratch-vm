// @ts-check


/**
 * @fileoverview ProgramIR: the IR of every script and procedure of every original target, plus the
 * whole-program analyses of spec 02 (call graph, yields, mod/ref, retire, write types).
 *
 * Building IR is cheap (no JS is generated). Modules are generated lazily per sprite (index.js).
 */

const {ScriptTreeGenerator} = require('../compiler/irgen');
const {InputType} = require('../compiler/enums');
const {walkStack, StackOpcode, InputOpcode} = require('./ir-walk');
const callgraph = require('./analysis/callgraph');
const yieldsAnalysis = require('./analysis/yields');
const modref = require('./analysis/modref');
const types = require('./analysis/types');

const parseIsWarp = variant => variant.charAt(0) === 'W';
const parseProcedureCode = variant => variant.substring(1);

/**
 * A compilation unit: one hat script or one procedure variant.
 */
class Unit {
    /**
     * @param {SpriteIR} sprite owning sprite
     * @param {string} key unique key within the sprite
     */
    constructor (sprite, key) {
        this.sprite = sprite;
        this.key = key;
        /** @type {import('../compiler/intermediate').IntermediateScript|null} */
        this.ir = null;
        /** @type {Error|null} */
        this.error = null;
        this.isProcedure = false;
        /** @type {string} */
        this.variant = '';
        /** @type {string|null} */
        this.topBlockId = null;
        /** @type {Unit[]} callees */
        this.calls = [];
        /** @type {'native'|'resumable'} */
        this.kind = 'native';
        /** true if this unit or a callee can end the whole thread (stop all, delete this clone) */
        this.mayRetire = false;
        /** @type {Set<string>} scalar variables read (transitive) */
        this.ref = new Set();
        /** @type {Set<string>} scalar variables written (transitive) */
        this.mod = new Set();
        /** @type {Set<string>} lists read (transitive) */
        this.lref = new Set();
        /** @type {Set<string>} lists modified (transitive) */
        this.lmod = new Set();
        /** @type {Set<string>} lists that may receive a non-number (transitive) */
        this.lmodnn = new Set();
        /** true if unsupported by the TTW backend (it or a callee) */
        this.unsupported = false;
        /** SCC id */
        this.scc = -1;
        /** true if part of a recursive cycle */
        this.recursive = false;
    }

    get supported () {
        return !this.unsupported && this.error === null && this.ir !== null;
    }
}

/**
 * The IR of one original target (shared by its clones).
 */
class SpriteIR {
    /**
     * @param {*} target original target
     */
    constructor (target) {
        this.target = target;
        this.blocks = target.blocks;
        this.isStage = target.isStage;
        /** @type {Map<string, Unit>} hat scripts by top block ID */
        this.scripts = new Map();
        /** @type {Map<string, Unit>} procedures by variant */
        this.procedures = new Map();
        /** Fake IntermediateRepresentation for IROptimizer: {procedures: {variant: IntermediateScript}} */
        this.irProcedures = {};
        /** @type {Map<Unit, number[]>} PT: argument types (02 §4) */
        this.argumentTypes = new Map();
        /** @type {Map<Unit, number>} RT: return types (02 §4) */
        this.returnTypes = new Map();
    }

    /**
     * @returns {Unit[]} all units
     */
    units () {
        return [...this.scripts.values(), ...this.procedures.values()];
    }

    /**
     * @param {*} variable variable descriptor from irgen
     * @returns {string} program-wide variable key
     */
    varKey (variable) {
        const scope = (variable.scope === 'stage' || this.isStage) ? 'stage' : this.target.id;
        return `${scope}:${variable.id}`;
    }
}

/**
 * Unsupported IR (spec 05 §5: old compiler compatibility layer goes to the TW backend).
 * @param {*} ir intermediate script
 * @returns {boolean} true if the TTW backend can't compile this IR
 */
const usesUnsupportedFeatures = ir => {
    let bad = false;
    walkStack(ir.stack, {
        block: block => {
            if (block.opcode === StackOpcode.OLD_COMPILER_COMPATIBILITY_LAYER) bad = true;
        },
        input: input => {
            if (input.opcode === InputOpcode.OLD_COMPILER_COMPATIBILITY_LAYER) bad = true;
        }
    });
    return bad;
};

/**
 * @param {*} runtime runtime
 * @param {*} target original target
 * @returns {SpriteIR} sprite IR
 */
const buildSpriteIR = (runtime, target) => {
    const sprite = new SpriteIR(target);
    const blocks = target.blocks;
    const fakeThread = {
        target,
        blockContainer: blocks,
        stackClick: false
    };

    const queue = [];
    const enqueue = variants => {
        for (const variant of variants) {
            if (!sprite.procedures.has(variant)) {
                const unit = new Unit(sprite, `p:${variant}`);
                unit.isProcedure = true;
                unit.variant = variant;
                sprite.procedures.set(variant, unit);
                queue.push(unit);
            }
        }
    };

    for (const topBlockId of blocks.getScripts()) {
        const topBlock = blocks.getBlock(topBlockId);
        if (!topBlock || !runtime.getIsHat(topBlock.opcode)) continue;
        const unit = new Unit(sprite, `s:${topBlockId}`);
        unit.topBlockId = topBlockId;
        sprite.scripts.set(topBlockId, unit);
        try {
            const generator = new ScriptTreeGenerator(fakeThread);
            unit.ir = generator.generate(topBlockId);
            enqueue(unit.ir.dependedProcedures);
        } catch (e) {
            unit.error = e;
        }
    }

    while (queue.length > 0) {
        const unit = queue.shift();
        try {
            const procedureCode = parseProcedureCode(unit.variant);
            const definitionId = blocks.getProcedureDefinition(procedureCode);
            const generator = new ScriptTreeGenerator(fakeThread);
            generator.setProcedureVariant(unit.variant);
            if (parseIsWarp(unit.variant)) generator.enableWarp();
            unit.ir = generator.generate(definitionId);
            sprite.irProcedures[unit.variant] = unit.ir;
            enqueue(unit.ir.dependedProcedures);
        } catch (e) {
            unit.error = e;
        }
    }

    for (const unit of sprite.units()) {
        if (unit.ir && usesUnsupportedFeatures(unit.ir)) {
            unit.unsupported = true;
        }
    }

    return sprite;
};

/**
 * Generate a fresh copy of a unit's IR (used for generic twins, which are typed differently).
 * @param {import('./program').Unit} unit unit
 * @returns {*} intermediate script
 */
const regenerateUnitIR = unit => {
    const sprite = unit.sprite;
    const fakeThread = {
        target: sprite.target,
        blockContainer: sprite.blocks,
        stackClick: false
    };
    const generator = new ScriptTreeGenerator(fakeThread);
    if (unit.isProcedure) {
        generator.setProcedureVariant(unit.variant);
        if (parseIsWarp(unit.variant)) generator.enableWarp();
        const ir = generator.generate(sprite.blocks.getProcedureDefinition(parseProcedureCode(unit.variant)));
        ir.yields = unit.kind === 'resumable';
        return ir;
    }
    const ir = generator.generate(unit.topBlockId);
    ir.yields = unit.kind === 'resumable';
    return ir;
};

class ProgramIR {
    /**
     * @param {*} runtime runtime
     */
    constructor (runtime) {
        this.runtime = runtime;
        /** @type {Map<*, SpriteIR>} by original target's blocks container */
        this.sprites = new Map();
        /** @type {Map<string, number>} write type of each scalar variable (02 §4) */
        this.writeTypes = new Map();
    }

    /**
     * Build the IR of every original target and run the whole-program analyses.
     * @param {*} runtime runtime
     * @returns {ProgramIR} program
     */
    static build (runtime) {
        const program = new ProgramIR(runtime);
        for (const target of runtime.targets) {
            if (!target.isOriginal) continue;
            if (program.sprites.has(target.blocks)) continue;
            program.sprites.set(target.blocks, buildSpriteIR(runtime, target));
        }
        program.analyze();
        return program;
    }

    analyze () {
        for (const sprite of this.sprites.values()) {
            const order = callgraph.analyze(sprite);
            yieldsAnalysis.analyze(sprite, order);
            modref.analyze(sprite, order);
        }
        this.writeTypes = types.computeWriteTypes(this);
    }

    /**
     * @param {string} key variable key
     * @returns {boolean} true if every write to the variable in the whole program is a number (02 §4)
     */
    isProgramNumber (key) {
        const t = this.writeTypes.get(key);
        return typeof t === 'number' && t !== 0 && (t & InputType.NUMBER_OR_NAN) === t;
    }
}

module.exports = {
    ProgramIR,
    SpriteIR,
    Unit,
    buildSpriteIR,
    regenerateUnitIR,
    parseIsWarp,
    parseProcedureCode
};
