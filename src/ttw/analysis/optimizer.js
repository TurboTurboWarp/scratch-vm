// @ts-check

/**
 * @fileoverview TW's IROptimizer, extended to also analyze and optimize procedure call arguments.
 * TW's optimizer skips the `arguments` array of procedure calls, so argument expressions keep the
 * types they were created with and their casts are never removed. TTW needs their real types for
 * interprocedural argument types (02 §4).
 */

const {IROptimizer, TypeState} = require('../../compiler/iroptimizer');
const {IntermediateInput, IntermediateStack} = require('../../compiler/intermediate');

const INLINE_OPCODE = 'ttw.inline';
const INLINE_RETURN_OPCODE = 'ttw.inlineReturn';

class TTWOptimizer extends IROptimizer {
    constructor (ir) {
        super(ir);
        /**
         * States at `return`s of the inlined bodies being analyzed (innermost last).
         * @type {Array<TypeState|null>}
         */
        this.inlineExits = [];
    }

    /**
     * Inlined procedure bodies (inline.js) are analyzed in the caller's context.
     * @param {*} stackBlock block
     * @param {TypeState} state state
     * @returns {boolean} modified
     */
    analyzeStackBlock (stackBlock, state) {
        if (stackBlock.opcode === INLINE_OPCODE) {
            const inputs = stackBlock.inputs;
            let modified = this.analyzeInputs(inputs, state);
            inputs.args.forEach((arg, k) => {
                for (const raw of inputs.argRefs[k]) raw.type = arg.type;
            });
            this.inlineExits.push(null);
            // @ts-ignore private
            modified = this.analyzeStack(inputs.body, state) || modified;
            const exits = this.inlineExits.pop();
            if (exits) modified = state.or(exits) || modified;
            return modified;
        }
        if (stackBlock.opcode === INLINE_RETURN_OPCODE) {
            const modified = this.analyzeInputs(stackBlock.inputs, state);
            const top = this.inlineExits.length - 1;
            if (this.inlineExits[top] === null) this.inlineExits[top] = state.clone();
            else this.inlineExits[top].or(state);
            return modified;
        }
        // @ts-ignore private
        return super.analyzeStackBlock(stackBlock, state);
    }

    /**
     * @param {Object<any, any>} inputs inputs
     * @param {TypeState} state state
     * @returns {boolean} modified
     */
    analyzeInputs (inputs, state) {
        let modified = false;
        for (const inputName in inputs) {
            const input = inputs[inputName];
            if (input instanceof IntermediateInput) {
                // @ts-ignore private
                modified = this.analyzeInputBlock(input, state) || modified;
            } else if (Array.isArray(input)) {
                for (const element of input) {
                    if (element instanceof IntermediateInput) {
                        // @ts-ignore private
                        modified = this.analyzeInputBlock(element, state) || modified;
                    }
                }
            }
        }
        return modified;
    }

    /**
     * @param {IntermediateInput} input input
     * @param {TypeState} state state
     * @returns {IntermediateInput} optimized input
     */
    optimizeInput (input, state) {
        for (const key in input.inputs) {
            const value = input.inputs[key];
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    if (value[i] instanceof IntermediateInput) {
                        value[i] = this.optimizeInput(value[i], state);
                    }
                }
            }
        }
        // @ts-ignore private
        return super.optimizeInput(input, state);
    }

    /**
     * @param {IntermediateStack?} stack stack
     * @param {TypeState} state state before the stack runs
     */
    optimizeStack (stack, state) {
        if (!stack) return;
        for (const stackBlock of stack.blocks) {
            if (stackBlock.entryState) state = stackBlock.entryState;
            for (const inputKey in stackBlock.inputs) {
                const input = stackBlock.inputs[inputKey];
                if (input instanceof IntermediateInput) {
                    stackBlock.inputs[inputKey] = this.optimizeInput(input, state);
                } else if (input instanceof IntermediateStack) {
                    this.optimizeStack(input, state);
                } else if (Array.isArray(input)) {
                    for (let i = 0; i < input.length; i++) {
                        if (input[i] instanceof IntermediateInput) {
                            input[i] = this.optimizeInput(input[i], state);
                        }
                    }
                }
            }
            if (stackBlock.exitState) {
                state = stackBlock.exitState;
            }
        }
    }
}

module.exports = {TTWOptimizer, TypeState};
