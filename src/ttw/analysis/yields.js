// @ts-check


/**
 * @fileoverview yields analysis (spec 02 §2): a unit is resumable if it yields itself
 * (TW irgen's script.yields: non-warp loops, waits, compat layer, hats, non-warp recursion, warp timer loops)
 * or calls a resumable unit. Unsupported units propagate to their callers.
 */

/**
 * @param {import('../program').SpriteIR} sprite sprite
 * @param {Array<import('../program').Unit[]>} order SCCs, callees first
 */
const analyze = (sprite, order) => {
    for (const scc of order) {
        let changed = true;
        for (const unit of scc) {
            unit.kind = (unit.ir && unit.ir.yields) ? 'resumable' : 'native';
            if (!unit.ir || unit.error) unit.unsupported = true;
        }
        while (changed) {
            changed = false;
            for (const unit of scc) {
                for (const callee of unit.calls) {
                    if (callee.kind === 'resumable' && unit.kind !== 'resumable') {
                        unit.kind = 'resumable';
                        changed = true;
                    }
                    if (callee.unsupported && !unit.unsupported) {
                        unit.unsupported = true;
                        changed = true;
                    }
                }
            }
        }
        // TW's IROptimizer reads `yields` on procedures to decide how calls affect type state.
        for (const unit of scc) {
            if (unit.ir) unit.ir.yields = unit.kind === 'resumable';
        }
    }
};

module.exports = {analyze};
