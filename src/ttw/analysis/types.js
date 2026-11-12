// @ts-check


/**
 * @fileoverview Whole-program write types WT(V) (spec 02 §4).
 *
 * WT(V) = union of the types of every value any script of any sprite writes to V, plus the type of the
 * current value. WT is only used to choose which variables get an entry type guard; soundness comes from
 * the runtime guard and TW's flow-sensitive analysis inside each unit (see emit.js).
 */

const {TTWOptimizer: IROptimizer, TypeState} = require('./optimizer');
const {IntermediateInput} = require('../../compiler/intermediate');
const {InputType} = require('../../compiler/enums');
const {walkStack, StackOpcode, InputOpcode} = require('../ir-walk');

/**
 * @param {*} value runtime value
 * @returns {number} InputType of the value
 */
const typeOfValue = value => {
    if (typeof value === 'number') return IntermediateInput.getNumberInputType(value);
    if (typeof value === 'boolean') return InputType.BOOLEAN;
    if (typeof value === 'string') {
        const n = +value;
        if (value === 'true' || value === 'false') return InputType.STRING_BOOLEAN;
        if (!Number.isNaN(n) && (value.trim() !== '' || value.includes('\t'))) return InputType.STRING_NUM;
        return InputType.STRING_NAN;
    }
    return InputType.ANY;
};

/**
 * Reset per-block analysis state left by a previous IROptimizer pass.
 * @param {*} stack stack
 */
const resetAnalysisState = stack => {
    walkStack(stack, {
        block: block => {
            block.entryState = null;
            block.exitState = null;
        }
    });
};

/**
 * Run TW's type analysis (without optimizing) on a unit.
 * @param {import('../program').SpriteIR} sprite sprite
 * @param {*} ir intermediate script
 * @param {TypeState} entryState entry state
 * @returns {TypeState} exit state
 */
const analyzeUnit = (sprite, ir, entryState) => {
    const optimizer = new IROptimizer({procedures: sprite.irProcedures});
    resetAnalysisState(ir.stack);
    const state = entryState.clone();
    // @ts-ignore private
    optimizer.exitState = null;
    // @ts-ignore private
    optimizer.analyzeStack(ir.stack, state);
    // @ts-ignore private
    optimizer.addPossibleExitState(state);
    // @ts-ignore private
    return optimizer.exitState;
};

/**
 * Compute ANY-entry exit summaries for every procedure (callees first), as TW does.
 * @param {import('../program').SpriteIR} sprite sprite
 */
const computeSummaries = sprite => {
    const done = new Set();
    const visit = unit => {
        if (done.has(unit) || !unit.ir) return;
        done.add(unit);
        for (const callee of unit.calls) visit(callee);
        unit.ir.cachedAnalysisEndState = analyzeUnit(sprite, unit.ir, new TypeState());
    };
    for (const unit of sprite.procedures.values()) visit(unit);
};

/**
 * @param {import('../program').ProgramIR} program program
 * @returns {Map<string, number>} write types
 */
const computeWriteTypes = program => {
    const wt = new Map();
    const any = new Set();
    const anyNames = new Set();
    const add = (key, type) => {
        wt.set(key, (wt.get(key) || 0) | type);
    };

    for (const sprite of program.sprites.values()) {
        // eslint-disable-next-line no-use-before-define
        inferProcedureTypes(sprite);
        // Current values (of the original; clones start as copies).
        for (const id of Object.keys(sprite.target.variables)) {
            const variable = sprite.target.variables[id];
            if (variable.type !== '') continue;
            const key = `${sprite.isStage ? 'stage' : sprite.target.id}:${id}`;
            if (variable.isCloud) any.add(key);
            add(key, typeOfValue(variable.value));
        }
        for (const unit of sprite.units()) {
            if (!unit.ir) continue;
            analyzeUnit(sprite, unit.ir, new TypeState());
            walkStack(unit.ir.stack, {
                block: block => {
                    if (block.opcode === StackOpcode.VAR_SET) {
                        const key = sprite.varKey(block.inputs.variable);
                        if (block.inputs.variable.isCloud) any.add(key);
                        add(key, block.inputs.value.type);
                    } else if (block.opcode === StackOpcode.CONTROL_FOR) {
                        add(sprite.varKey(block.inputs.variable), InputType.NUMBER_POS_INT | InputType.NUMBER_ZERO);
                    } else if (block.opcode === StackOpcode.COMPATIBILITY_LAYER) {
                        // Extension blocks with variable fields may write the variable.
                        for (const field of Object.keys(block.inputs.fields || {})) {
                            if (field === 'VARIABLE') anyNames.add(block.inputs.fields[field]);
                        }
                    }
                }
            });
        }
    }
    if (anyNames.size > 0) {
        for (const sprite of program.sprites.values()) {
            for (const id of Object.keys(sprite.target.variables)) {
                if (anyNames.has(sprite.target.variables[id].name)) {
                    any.add(`${sprite.isStage ? 'stage' : sprite.target.id}:${id}`);
                }
            }
        }
    }
    for (const key of any) wt.set(key, InputType.ANY);
    return wt;
};

/**
 * Set the static types of procedure argument reporters and procedure call results.
 * @param {import('../program').SpriteIR} sprite sprite
 * @param {Map<*, number[]>} pt argument types per procedure
 * @param {Map<*, number>} rt return type per procedure
 */
const seedProcedureTypes = (sprite, pt, rt) => {
    for (const unit of sprite.units()) {
        if (!unit.ir) continue;
        // eslint-disable-next-line no-use-before-define
        seedIRTypes(sprite, unit, unit.ir, pt, rt);
    }
};

/**
 * @param {import('../program').SpriteIR} sprite sprite
 * @param {import('../program').Unit} unit unit
 * @param {*} ir an IR of the unit
 * @param {Map<*, number[]>} pt argument types per procedure
 * @param {Map<*, number>} rt return type per procedure
 */
const seedIRTypes = (sprite, unit, ir, pt, rt) => {
    const args = unit.isProcedure ? pt.get(unit) : null;
    walkStack(ir.stack, {
        input: input => {
            if (input.opcode === InputOpcode.PROCEDURE_ARGUMENT) {
                if (args) input.type = args[input.inputs.index] || 0;
            } else if (input.opcode === InputOpcode.PROCEDURE_CALL) {
                const callee = sprite.procedures.get(input.inputs.variant);
                if (callee && callee.ir && callee.ir.stack !== null && rt.has(callee)) {
                    input.type = rt.get(callee);
                }
            }
        }
    });
};

/**
 * @param {*} ir procedure IR
 * @returns {boolean} true if the end of the procedure (an implicit `return ""`) may be reached
 */
const endMayBeReached = ir => {
    const blocks = ir.stack ? ir.stack.blocks : [];
    if (blocks.length === 0) return true;
    const last = blocks[blocks.length - 1];
    return last.opcode !== StackOpcode.PROCEDURE_RETURN && last.opcode !== StackOpcode.CONTROL_STOP_ALL;
};

/**
 * Interprocedural argument and return types PT(U, k) / RT(U) (spec 02 §4): a fixpoint over the sprite's
 * call sites, starting from bottom. Procedures are sprite-local and TTW procedure functions are only
 * called by TTW code of the same module, so the result is sound. Afterwards the IR nodes carry the types
 * and the exit summaries are recomputed with them.
 * @param {import('../program').SpriteIR} sprite sprite
 */
const inferProcedureTypes = sprite => {
    const pt = new Map();
    const rt = new Map();
    for (const unit of sprite.procedures.values()) {
        if (!unit.ir) continue;
        pt.set(unit, unit.ir.arguments.map(() => 0));
        rt.set(unit, 0);
    }
    for (let iteration = 0; iteration < 50; iteration++) {
        seedProcedureTypes(sprite, pt, rt);
        computeSummaries(sprite);
        let changed = false;
        const widenArg = (callee, k, type) => {
            const args = pt.get(callee);
            if (!args || k >= args.length) return;
            const t = args[k] | type;
            if (t !== args[k]) {
                args[k] = t;
                changed = true;
            }
        };
        const widenReturn = (unit, type) => {
            const t = rt.get(unit) | type;
            if (t !== rt.get(unit)) {
                rt.set(unit, t);
                changed = true;
            }
        };
        const noteCall = node => {
            const callee = sprite.procedures.get(node.variant);
            if (!callee || !callee.ir || callee.ir.stack === null) return;
            node.arguments.forEach((arg, k) => widenArg(callee, k, arg.type));
        };
        for (const unit of sprite.units()) {
            if (!unit.ir) continue;
            analyzeUnit(sprite, unit.ir, new TypeState());
            walkStack(unit.ir.stack, {
                block: block => {
                    if (block.opcode === StackOpcode.PROCEDURE_CALL) {
                        noteCall(block.inputs);
                    } else if (block.opcode === StackOpcode.PROCEDURE_RETURN && unit.isProcedure) {
                        widenReturn(unit, block.inputs.value.type);
                    } else if (block.opcode === StackOpcode.CONTROL_STOP_SCRIPT && unit.isProcedure) {
                        widenReturn(unit, InputType.STRING_NAN);
                    }
                },
                input: input => {
                    if (input.opcode === InputOpcode.PROCEDURE_CALL) noteCall(input.inputs);
                }
            });
            if (unit.isProcedure && endMayBeReached(unit.ir)) {
                widenReturn(unit, InputType.STRING_NAN);
            }
        }
        if (!changed) {
            sprite.argumentTypes = pt;
            sprite.returnTypes = rt;
            return;
        }
    }
    // Did not converge: give up on precision.
    for (const [unit, args] of pt) pt.set(unit, args.map(() => InputType.ANY));
    for (const unit of rt.keys()) rt.set(unit, InputType.ANY);
    seedProcedureTypes(sprite, pt, rt);
    computeSummaries(sprite);
    sprite.argumentTypes = pt;
    sprite.returnTypes = rt;
};

/**
 * Analyze then optimize (remove redundant casts) a unit for code generation.
 * @param {import('../program').SpriteIR} sprite sprite
 * @param {*} ir intermediate script
 * @param {TypeState} entryState entry state
 */
const optimizeUnit = (sprite, ir, entryState) => {
    analyzeUnit(sprite, ir, entryState);
    const optimizer = new IROptimizer({procedures: sprite.irProcedures});
    // @ts-ignore private
    optimizer.optimizeStack(ir.stack, entryState.clone());
};

module.exports = {
    inferProcedureTypes,
    seedIRTypes,
    computeWriteTypes,
    optimizeUnit,
    computeSummaries,
    analyzeUnit,
    resetAnalysisState,
    typeOfValue
};
