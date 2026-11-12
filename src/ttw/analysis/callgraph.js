// @ts-check


/**
 * @fileoverview Call graph and strongly connected components (spec 02 §1).
 * Nodes are units (scripts and procedure variants) of one sprite: Scratch procedures are sprite-local.
 */

/**
 * Link callees and compute SCCs with Tarjan's algorithm.
 * @param {import('../program').SpriteIR} sprite sprite
 * @returns {Array<import('../program').Unit[]>} SCCs in reverse topological order (callees first)
 */
const analyze = sprite => {
    const units = sprite.units();
    for (const unit of units) {
        unit.calls = [];
        if (!unit.ir) continue;
        for (const variant of unit.ir.dependedProcedures) {
            const callee = sprite.procedures.get(variant);
            if (callee) unit.calls.push(callee);
        }
    }

    let index = 0;
    const indices = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];

    const strongConnect = root => {
        // Iterative Tarjan to avoid deep recursion on long call chains.
        const work = [[root, 0]];
        indices.set(root, index);
        lowlink.set(root, index);
        index++;
        stack.push(root);
        onStack.add(root);
        while (work.length > 0) {
            const top = work[work.length - 1];
            const v = top[0];
            if (top[1] < v.calls.length) {
                const w = v.calls[top[1]++];
                if (!indices.has(w)) {
                    indices.set(w, index);
                    lowlink.set(w, index);
                    index++;
                    stack.push(w);
                    onStack.add(w);
                    work.push([w, 0]);
                } else if (onStack.has(w)) {
                    lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
                }
                continue;
            }
            work.pop();
            if (work.length > 0) {
                const parent = work[work.length - 1][0];
                lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(v)));
            }
            if (lowlink.get(v) === indices.get(v)) {
                const scc = [];
                let w;
                do {
                    w = stack.pop();
                    onStack.delete(w);
                    scc.push(w);
                } while (w !== v);
                sccs.push(scc);
            }
        }
    };

    for (const unit of units) {
        if (!indices.has(unit)) strongConnect(unit);
    }

    sccs.forEach((scc, id) => {
        for (const unit of scc) {
            unit.scc = id;
            unit.recursive = scc.length > 1 || unit.calls.includes(unit);
        }
    });

    // Tarjan emits SCCs in reverse topological order already.
    return sccs;
};

module.exports = {analyze};
