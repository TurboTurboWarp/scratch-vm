// @ts-check


/**
 * @fileoverview mod/ref analysis (spec 02 §3), transitive over callees. Also computes mayRetire.
 */

const {IntermediateInput} = require('../../compiler/intermediate');
const {InputType} = require('../../compiler/enums');
const {walkStack, StackOpcode, InputOpcode} = require('../ir-walk');

/**
 * @param {IntermediateInput} input value stored into a list
 * @returns {boolean} true if it may be a non-number
 */
const mayBeNonNumber = input => !(input instanceof IntermediateInput) || !input.isAlwaysType(InputType.NUMBER_OR_NAN);

/**
 * @param {import('../program').Unit} unit unit
 */
const collectOwn = unit => {
    const sprite = unit.sprite;
    walkStack(unit.ir.stack, {
        block: block => {
            const inputs = block.inputs;
            switch (block.opcode) {
            case StackOpcode.VAR_SET:
            case StackOpcode.CONTROL_FOR:
                unit.mod.add(sprite.varKey(inputs.variable));
                break;
            case StackOpcode.LIST_ADD:
            case StackOpcode.LIST_INSERT:
            case StackOpcode.LIST_REPLACE:
                unit.lmod.add(sprite.varKey(inputs.list));
                if (block.opcode !== StackOpcode.LIST_REPLACE || mayBeNonNumber(inputs.item)) {
                    unit.lmodnn.add(sprite.varKey(inputs.list));
                }
                break;
            case StackOpcode.LIST_DELETE:
            case StackOpcode.LIST_DELETE_ALL:
                unit.lmod.add(sprite.varKey(inputs.list));
                break;
            case StackOpcode.CONTROL_STOP_ALL:
            case StackOpcode.CONTROL_CLONE_DELETE:
                unit.mayRetire = true;
                break;
            }
        },
        input: input => {
            const inputs = input.inputs;
            switch (input.opcode) {
            case InputOpcode.VAR_GET:
                unit.ref.add(sprite.varKey(inputs.variable));
                break;
            case InputOpcode.LIST_GET:
            case InputOpcode.LIST_LENGTH:
            case InputOpcode.LIST_CONTAINS:
            case InputOpcode.LIST_INDEX_OF:
            case InputOpcode.LIST_CONTENTS:
                unit.lref.add(sprite.varKey(inputs.list));
                break;
            }
        }
    });
};

const addAll = (into, from) => {
    let changed = false;
    for (const x of from) {
        if (!into.has(x)) {
            into.add(x);
            changed = true;
        }
    }
    return changed;
};

/**
 * @param {import('../program').SpriteIR} sprite sprite
 * @param {Array<import('../program').Unit[]>} order SCCs, callees first
 */
const analyze = (sprite, order) => {
    for (const scc of order) {
        for (const unit of scc) {
            if (unit.ir) collectOwn(unit);
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const unit of scc) {
                for (const callee of unit.calls) {
                    changed = addAll(unit.ref, callee.ref) || changed;
                    changed = addAll(unit.mod, callee.mod) || changed;
                    changed = addAll(unit.lref, callee.lref) || changed;
                    changed = addAll(unit.lmod, callee.lmod) || changed;
                    changed = addAll(unit.lmodnn, callee.lmodnn) || changed;
                    if (callee.mayRetire && !unit.mayRetire) {
                        unit.mayRetire = true;
                        changed = true;
                    }
                }
            }
        }
    }
};

module.exports = {analyze};
