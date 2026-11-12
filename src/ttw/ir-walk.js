// @ts-check


/**
 * @fileoverview Generic traversal helpers for TW's IR.
 */

const {IntermediateInput, IntermediateStack} = require('../compiler/intermediate');
const {StackOpcode, InputOpcode} = require('../compiler/enums');

/**
 * @param {*} v value
 * @returns {boolean} true if v is a variable descriptor produced by irgen's descendVariable
 */
const isVariableDescriptor = v => (
    v !== null && typeof v === 'object' && typeof v.scope === 'string' && 'id' in v && 'isCloud' in v
);

/**
 * Visit the direct IR children of a node's `inputs` object, in evaluation (key) order.
 * @param {object} inputs node.inputs
 * @param {(child: IntermediateInput, set: (replacement: IntermediateInput) => void) => void} onInput called for inputs
 * @param {(stack: IntermediateStack, key: string) => void} [onStack] called for substacks
 */
const forEachChild = (inputs, onInput, onStack) => {
    for (const key of Object.keys(inputs)) {
        const v = inputs[key];
        if (v instanceof IntermediateInput) {
            onInput(v, r => {
                inputs[key] = r;
            });
        } else if (v instanceof IntermediateStack) {
            if (onStack) onStack(v, key);
        } else if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
                if (v[i] instanceof IntermediateInput) {
                    onInput(v[i], r => {
                        v[i] = r;
                    });
                }
            }
        } else if (v !== null && typeof v === 'object' && !isVariableDescriptor(v)) {
            for (const k2 of Object.keys(v)) {
                const w = v[k2];
                if (w instanceof IntermediateInput) {
                    onInput(w, r => {
                        v[k2] = r;
                    });
                } else if (w instanceof IntermediateStack) {
                    if (onStack) onStack(w, `${key}.${k2}`);
                }
            }
        }
    }
};

const LOOP_OPCODES = new Set([
    StackOpcode.CONTROL_REPEAT,
    StackOpcode.CONTROL_WHILE,
    StackOpcode.CONTROL_FOR
]);

/**
 * @typedef Visitor
 * @property {(block: *, loopDepth: number) => void} [block]
 * @property {(input: IntermediateInput, loopDepth: number) => void} [input]
 */

/**
 * @param {IntermediateInput} input input
 * @param {Visitor} visitor visitor
 * @param {number} depth loop depth
 */
const walkInput = (input, visitor, depth) => {
    if (visitor.input) visitor.input(input, depth);
    forEachChild(input.inputs, child => walkInput(child, visitor, depth));
};

/**
 * @param {IntermediateStack|null} stack stack
 * @param {Visitor} visitor visitor
 * @param {number} [depth] loop depth
 */
const walkStack = (stack, visitor, depth = 0) => {
    if (!stack) return;
    for (const block of stack.blocks) {
        if (visitor.block) visitor.block(block, depth);
        const isLoop = LOOP_OPCODES.has(block.opcode);
        const isCompatLoop = block.opcode === StackOpcode.COMPATIBILITY_LAYER;
        forEachChild(block.inputs,
            child => walkInput(child, visitor, isLoop || isCompatLoop ? depth + 1 : depth),
            sub => walkStack(sub, visitor, isLoop || isCompatLoop ? depth + 1 : depth));
    }
};

/**
 * Count IR nodes (for size heuristics).
 * @param {IntermediateStack|null} stack stack
 * @returns {number} node count
 */
const countNodes = stack => {
    let n = 0;
    walkStack(stack, {
        block: () => {
            n++;
        },
        input: () => {
            n++;
        }
    });
    return n;
};

module.exports = {
    forEachChild,
    walkInput,
    walkStack,
    countNodes,
    isVariableDescriptor,
    LOOP_OPCODES,
    StackOpcode,
    InputOpcode
};
