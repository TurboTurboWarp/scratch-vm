// @ts-check

/**
 * @fileoverview Inlining of small procedures (spec 02 §5).
 *
 * A statement call to a native, non-recursive procedure is replaced by a `ttw.inline` block holding a fresh
 * copy of the callee's IR. Arguments become temporaries (`ttw.raw` inputs), `return` and `stop this script`
 * become `ttw.inlineReturn` (a `break` out of a labelled block). The caller's type analysis analyzes the
 * inlined body in the caller's context (see optimizer.js), so argument types become site specific.
 */

const {IntermediateInput, IntermediateStack, IntermediateStackBlock} = require('../../compiler/intermediate');
const {walkStack, countNodes, StackOpcode, InputOpcode, LOOP_OPCODES} = require('../ir-walk');

/**
 * @param {*} stack stack
 * @returns {boolean} true if the stack contains a loop
 */
const hasLoop = stack => {
    let found = false;
    walkStack(stack, {
        block: block => {
            if (LOOP_OPCODES.has(block.opcode)) found = true;
        }
    });
    return found;
};

const INLINE_OPCODE = 'ttw.inline';
const INLINE_RETURN_OPCODE = 'ttw.inlineReturn';
const RAW_OPCODE = 'ttw.raw';

const SMALL = 40;
const SINGLE_SITE = 400;
const MAX_FUNCTION_NODES = 3000;
const MAX_DEPTH = 3;

let siteCounter = 0;

/**
 * @param {import('../program').SpriteIR} sprite sprite
 * @returns {Map<*, number>} number of call sites of each procedure
 */
const countCallSites = sprite => {
    const counts = new Map();
    for (const unit of sprite.units()) {
        if (!unit.ir) continue;
        const note = node => {
            const callee = sprite.procedures.get(node.variant);
            if (callee) counts.set(callee, (counts.get(callee) || 0) + 1);
        };
        walkStack(unit.ir.stack, {
            block: block => {
                if (block.opcode === StackOpcode.PROCEDURE_CALL) note(block.inputs);
            },
            input: input => {
                if (input.opcode === InputOpcode.PROCEDURE_CALL) note(input.inputs);
            }
        });
    }
    return counts;
};

/**
 * Turn a fresh copy of a callee's IR into an inline block.
 * @param {*} calleeIR fresh callee IR
 * @param {IntermediateInput[]} args call arguments
 * @returns {IntermediateStackBlock} ttw.inline block
 */
const makeInlineBlock = (calleeIR, args) => {
    const site = siteCounter++;
    const label = `inl${site}`;
    const temps = args.map((_, k) => `q${site}_${k}`);
    const argRefs = args.map(() => []);
    const rewriteInputs = inputs => {
        for (const key of Object.keys(inputs)) {
            const v = inputs[key];
            const rewrite = input => {
                if (input.opcode === InputOpcode.PROCEDURE_ARGUMENT) {
                    const k = input.inputs.index;
                    // An argument that the call doesn't pass reads as "" (TW passes nothing for it).
                    if (k >= temps.length) return new IntermediateInput(InputOpcode.CONSTANT, input.type, {value: ''});
                    const raw = new IntermediateInput(RAW_OPCODE, input.type, {js: temps[k]});
                    argRefs[k].push(raw);
                    return raw;
                }
                rewriteInputs(input.inputs);
                return input;
            };
            if (v instanceof IntermediateInput) {
                inputs[key] = rewrite(v);
            } else if (v instanceof IntermediateStack) {
                // eslint-disable-next-line no-use-before-define
                rewriteStack(v);
            } else if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    if (v[i] instanceof IntermediateInput) v[i] = rewrite(v[i]);
                }
            } else if (v !== null && typeof v === 'object' && !('scope' in v && 'isCloud' in v)) {
                for (const k2 of Object.keys(v)) {
                    if (v[k2] instanceof IntermediateInput) v[k2] = rewrite(v[k2]);
                    else if (v[k2] instanceof IntermediateStack) {
                        // eslint-disable-next-line no-use-before-define
                        rewriteStack(v[k2]);
                    }
                }
            }
        }
    };
    const rewriteStack = stack => {
        for (let i = 0; i < stack.blocks.length; i++) {
            const block = stack.blocks[i];
            if (block.opcode === StackOpcode.PROCEDURE_RETURN) {
                rewriteInputs(block.inputs);
                const r = new IntermediateStackBlock(INLINE_RETURN_OPCODE, {value: block.inputs.value, label});
                r.blockId = block.blockId;
                stack.blocks[i] = r;
            } else if (block.opcode === StackOpcode.CONTROL_STOP_SCRIPT) {
                const r = new IntermediateStackBlock(INLINE_RETURN_OPCODE, {value: null, label});
                r.blockId = block.blockId;
                stack.blocks[i] = r;
            } else {
                rewriteInputs(block.inputs);
            }
        }
    };
    const body = calleeIR.stack || new IntermediateStack();
    rewriteStack(body);
    return new IntermediateStackBlock(INLINE_OPCODE, {args, body, temps, label, argRefs}, false);
};

/**
 * Inline eligible statement calls in an IR (in place).
 * @param {import('../program').Unit} unit caller
 * @param {*} ir caller IR (unit.ir or a twin copy)
 * @param {(unit: import('../program').Unit) => *} freshIR makes a fresh, type-seeded IR of a callee
 * @returns {number} number of inlined call sites
 */
const inlineCalls = (unit, ir, freshIR) => {
    const sprite = unit.sprite;
    if (!sprite.callSiteCounts) sprite.callSiteCounts = countCallSites(sprite);
    const sites = sprite.callSiteCounts;
    let total = countNodes(ir.stack);
    let inlined = 0;

    const eligible = (callee, inLoop) => {
        if (!callee || callee === unit || !callee.supported || callee.recursive) return false;
        if (callee.kind !== 'native' || !callee.ir || callee.ir.stack === null) return false;
        // Inlining saves a call per execution of the site. A procedure with loops called from straight-line
        // code gains nothing, and would move its loops into the caller (worse for V8 OSR, 07 F3).
        if (!inLoop && hasLoop(callee.ir.stack)) return false;
        const size = countNodes(callee.ir.stack);
        if (!(size <= SMALL || (sites.get(callee) === 1 && size <= SINGLE_SITE))) return false;
        return total + size <= MAX_FUNCTION_NODES;
    };

    const visitStack = (stack, depth, inLoop) => {
        if (!stack) return;
        for (let i = 0; i < stack.blocks.length; i++) {
            const block = stack.blocks[i];
            if (block.opcode === StackOpcode.PROCEDURE_CALL && depth < MAX_DEPTH) {
                const callee = sprite.procedures.get(block.inputs.variant);
                if (eligible(callee, inLoop)) {
                    const calleeIR = freshIR(callee);
                    const inline = makeInlineBlock(calleeIR, block.inputs.arguments);
                    inline.blockId = block.blockId;
                    stack.blocks[i] = inline;
                    total += countNodes(inline.inputs.body);
                    inlined++;
                    visitStack(inline.inputs.body, depth + 1, inLoop);
                    continue;
                }
            }
            const loop = inLoop || LOOP_OPCODES.has(block.opcode) ||
                block.opcode === StackOpcode.COMPATIBILITY_LAYER;
            for (const key of Object.keys(block.inputs)) {
                const v = block.inputs[key];
                if (v instanceof IntermediateStack) {
                    visitStack(v, depth, loop);
                } else if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
                    !(v instanceof IntermediateInput)) {
                    for (const k2 of Object.keys(v)) {
                        if (v[k2] instanceof IntermediateStack) visitStack(v[k2], depth, loop);
                    }
                }
            }
        }
    };
    visitStack(ir.stack, 0, false);
    return inlined;
};

module.exports = {
    inlineCalls,
    countCallSites,
    INLINE_OPCODE,
    INLINE_RETURN_OPCODE,
    RAW_OPCODE
};
