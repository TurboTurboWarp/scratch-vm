// @ts-check
/* eslint-disable no-self-compare, no-undefined */


/**
 * @fileoverview Load-time normalization of canonical numeric strings (spec 03 §6).
 *
 * A string s is replaced by the number +s when !isNaN(+s) && (+s).toString() === s and s is not
 * the name of any costume or sound of any sprite. This is exactly the rule the TW compiler
 * applies to constants (ScriptTreeGenerator.createConstantInput). It is applied only when a
 * project or sprite is loaded, never to strings created at runtime.
 */

const Variable = require('../engine/variable');

/**
 * @param {*} runtime Runtime
 * @returns {Set<string>} names of every costume and sound of every original target
 */
const getNamesOfCostumesAndSounds = runtime => {
    const names = new Set();
    for (const target of runtime.targets) {
        if (!target.isOriginal || !target.sprite) continue;
        for (const costume of target.sprite.costumes) names.add(costume.name);
        for (const sound of target.sprite.sounds) names.add(sound.name);
    }
    return names;
};

/**
 * @param {*} value value
 * @param {Set<string>} names preserved strings
 * @returns {*} normalized value
 */
const normalizeValue = (value, names) => {
    if (typeof value !== 'string') return value;
    const n = +value;
    if (n === n && n.toString() === value && !names.has(value)) return n;
    return value;
};

/**
 * @param {*} runtime Runtime
 * @param {Array<*>} targets newly installed targets
 */
const normalizeTargets = (runtime, targets) => {
    const names = getNamesOfCostumesAndSounds(runtime);
    for (const target of targets) {
        if (!target) continue;
        const variables = target.variables;
        for (const id in variables) {
            const variable = variables[id];
            if (variable.type === Variable.SCALAR_TYPE) {
                // Cloud variables are exchanged with a server as-is.
                if (!variable.isCloud) variable.value = normalizeValue(variable.value, names);
            } else if (variable.type === Variable.LIST_TYPE) {
                const tl = variable._tl;
                if (tl.ext !== null) tl.sync();
                if (tl.objs.length === 0) continue;
                for (let k = 0; k < tl.len; k++) {
                    const x = tl.f64[k];
                    if (x === x) continue;
                    const o = tl.objs[k];
                    if (typeof o !== 'string') continue;
                    const v = normalizeValue(o, names);
                    if (v !== o) tl.storeAt(k, v);
                }
            }
        }
    }
};

module.exports = {
    normalizeTargets,
    normalizeValue,
    getNamesOfCostumesAndSounds
};
