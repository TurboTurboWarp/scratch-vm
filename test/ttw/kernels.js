/* eslint-disable max-len */
/**
 * @fileoverview Differential tests aimed at the TTW emitter's specialized list code: fused list reads in
 * comparisons and list stores, numeric-only inlined arguments, and range check hoisting of counted loops.
 * Each program is run with the TW backend, the TTW backend (default options and with the loop
 * specializations disabled) and the interpreter; all final variables and lists must be identical.
 */
const {test} = require('node:test');
const assert = require('node:assert');
const {runProject, compareResults} = require('./lib');
const {Proj, H} = require('../ttw-bench/sb');

const {add, sub, mul, div, mod, lt, gt, eq, or, not, join, get, set, chg, item, llen, push, repl, del, clear, repeat, until, arg, call} = H;

// Values that exercise every representation of a list item. Numeric strings that are not canonical
// ("05", " 7") stay strings when the project is loaded.
const MIXED = [3, 'apple', '', 10, 'Apple', '05', -2.5, 'NaN', ' 7', 0, 'Infinity', 'b', 1e21, 'true', 4, '', '', 'APPLE', ''];
const NUMS = [5, 3, 9, 1, 7, 2, 8];

const programs = {};

// Comparisons of list items with variables, constants and other list items; copies between lists.
programs.compareAndCopy = () => {
    const p = new Proj();
    const [i, t, gtc, ltc, eqc, empties, apples, fives, rgt] = ['i', 't', 'gtc', 'ltc', 'eqc', 'empties', 'apples', 'fives', 'rgt'].map(n => p.v(n));
    const A = p.l('A', MIXED);
    const B = p.l('B', NUMS);
    const C = p.l('C');
    const D = p.l('D', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const E = p.l('E', MIXED.map(() => 'x'));
    p.define('run', [], true, [
        set(i, 1),
        // A is longer than B and D: the "in range" version of this loop must not be taken.
        repeat(llen(A), [
            set(t, item(A, sub(add(llen(A), 1), get(i)))),
            H.if(gt(item(A, get(i)), item(B, get(i))), [chg(gtc, 1)]),
            H.if(lt(item(A, get(i)), get(t)), [chg(ltc, 1)]),
            H.if(eq(item(A, get(i)), get(t)), [chg(eqc, 1)]),
            H.if(eq(item(A, get(i)), ''), [chg(empties, 1)]),
            H.if(eq(item(A, get(i)), 'apple'), [chg(apples, 1)]),
            H.if(eq('5', item(A, get(i))), [chg(fives, 1)]),
            H.if(gt(5, item(B, get(i))), [chg(rgt, 1)]),
            H.if(lt(get(t), item(A, get(i))), [chg(rgt, 100)]),
            push(C, item(A, get(i))),
            repl(D, get(i), item(A, get(i))),
            repl(E, get(i), item(B, get(i))),
            chg(i, 1)
        ]),
        // Every list is long enough here.
        set(i, 1),
        repeat(llen(B), [
            H.if(gt(item(A, get(i)), item(B, get(i))), [chg(gtc, 1000)]),
            H.if(eq(item(E, get(i)), ''), [chg(empties, 1000)]),
            repl(A, get(i), item(D, get(i))),
            repl(D, get(i), add(item(B, get(i)), item(A, get(i)))),
            repl(E, get(i), item(C, add(get(i), 3))),
            chg(t, item(B, get(i))),
            chg(i, 1)
        ])
    ]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// Counted loops whose induction variable or count makes the hoisted range check fail (or barely pass).
programs.rangeEdges = () => {
    const p = new Proj();
    const [i, acc, n] = ['i', 'acc', 'n'].map(v => p.v(v));
    const A = p.l('A', NUMS);
    const M = p.l('M', MIXED);
    const O = p.l('O');
    const loop = (start, count, list) => [
        set(i, start),
        repeat(count, [
            chg(acc, item(list, get(i))),
            push(O, item(list, get(i))),
            repl(list, get(i), add(item(list, get(i)), 1)),
            H.if(gt(item(list, get(i)), 4), [chg(n, 1)]),
            chg(i, 1)
        ]),
        push(O, get(i))
    ];
    p.define('run', [], true, [
        ...loop(1, llen(A), A),
        ...loop(1.5, 3, A),
        ...loop(0, 4, A),
        ...loop(-2, 5, A),
        ...loop(5, 5, A),
        ...loop(1, 2.6, A),
        ...loop(1, 2.4, A),
        ...loop(2, 0, A),
        ...loop(3, -1, A),
        ...loop(7, 1, A),
        ...loop(8, 1, A),
        ...loop(1, llen(M), M),
        ...loop(3, 20, M),
        ...loop(1, llen(M), M)
    ]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// The induction variable starts as a string. (The compilers turn the constant "2" into a number when it is
// stored in a variable and the interpreter doesn't, so this one is not compared with the interpreter.)
programs.rangeStrings = () => {
    const p = new Proj();
    const [i, acc] = ['i', 'acc'].map(v => p.v(v));
    const A = p.l('A', NUMS);
    const O = p.l('O');
    const loop = (start, count) => [
        set(i, start),
        repeat(count, [chg(acc, item(A, get(i))), push(O, item(A, get(i))), repl(A, get(i), add(item(A, get(i)), 1)), chg(i, 1)]),
        push(O, get(i))
    ];
    p.define('run', [], true, [...loop('2', 3), ...loop('', 3), ...loop('abc', 2), ...loop(join('1', ''), 2), ...loop(join('a', 'b'), 2)]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// A loop that changes the list's length or the induction variable in ways that forbid hoisting.
programs.rangeUnsafe = () => {
    const p = new Proj();
    const [i, acc] = ['i', 'acc'].map(v => p.v(v));
    const A = p.l('A', NUMS);
    const B = p.l('B', NUMS);
    const O = p.l('O');
    p.define('shrink', [], true, [del(B, 1)]);
    p.define('skip', ['by'], true, [chg(i, arg('by'))]);
    p.define('run', [], true, [
        set(i, 1),
        repeat(llen(A), [push(O, item(A, get(i))), H.if(eq(mod(get(i), 3), 0), [del(A, 1)]), chg(i, 1)]),
        set(i, 1),
        repeat(6, [push(O, item(B, get(i))), call(p, 'shrink', []), chg(i, 1)]),
        set(i, 1),
        repeat(4, [push(O, item(O, get(i))), call(p, 'skip', [1]), chg(i, 1)]),
        set(i, 1),
        repeat(4, [push(O, item(O, get(i))), H.if(gt(get(i), 2), [set(i, 1)]), chg(acc, get(i)), chg(i, 1)]),
        set(i, 1),
        repeat(5, [chg(acc, item(O, get(i))), chg(i, 1), chg(acc, item(O, get(i))), chg(i, 1)]),
        set(i, 1),
        repeat(3, [chg(acc, item(O, get(i))), repeat(2, [chg(acc, item(O, get(i))), chg(i, 1)]), chg(i, 1)]),
        clear(B),
        set(i, 1),
        repeat(3, [push(O, item(B, get(i))), chg(i, 1)])
    ]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// Small procedures that get inlined, with arguments that are numbers, strings and list items.
programs.inlineArgs = () => {
    const p = new Proj();
    const [i, r, s, last] = ['i', 'r', 's', 'last'].map(v => p.v(v));
    const M = p.l('M', MIXED);
    const O = p.l('O');
    p.define('numeric', ['a', 'b'], true, [set(r, add(mul(arg('a'), 2), arg('b'))), chg(s, mul(arg('a'), arg('a')))]);
    p.define('keeps', ['a', 'b'], true, [set(last, arg('a')), chg(s, arg('b'))]);
    p.define('compares', ['a'], true, [H.if(eq(arg('a'), ''), [chg(s, 1000)]), H.if(gt(arg('a'), 3), [chg(s, 0.5)])]);
    p.define('run', [], true, [
        set(i, 1),
        repeat(llen(M), [
            call(p, 'numeric', [item(M, get(i)), item(M, sub(llen(M), get(i)))]),
            push(O, get(r)),
            call(p, 'keeps', [item(M, get(i)), item(M, get(i))]),
            push(O, get(last)),
            call(p, 'compares', [item(M, get(i))]),
            call(p, 'numeric', ['abc', item(M, add(get(i), 100))]),
            push(O, get(r)),
            chg(i, 1)
        ])
    ]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// Insertion sort of a mixed list (string comparisons in the inner loop) and of a numeric one.
programs.sortMixed = () => {
    const p = new Proj();
    const [i, j, t] = ['i', 'j', 't'].map(v => p.v(v));
    const sortList = a => [
        set(i, 2),
        repeat(sub(llen(a), 1), [
            set(t, item(a, get(i))),
            set(j, sub(get(i), 1)),
            until(or(lt(get(j), 1), not(gt(item(a, get(j)), get(t)))), [repl(a, add(get(j), 1), item(a, get(j))), chg(j, -1)]),
            repl(a, add(get(j), 1), get(t)),
            chg(i, 1)
        ])
    ];
    const M = p.l('M', MIXED);
    const N = p.l('N', NUMS.concat([0.5, -3, 1e300, 4, 4]));
    p.define('run', [], true, [...sortList(M), ...sortList(N)]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// Comparisons of list items with a variable that holds NaN, Infinity or a string (a NaN operand makes
// Scratch compare as strings).
programs.compareNaN = () => {
    const p = new Proj();
    const [i, t, k] = ['i', 't', 'k'].map(v => p.v(v));
    const A = p.l('A', [5, -1, 0, 'Infinity', '-Infinity', 'zebra', '', 1e300, 'NaN', 'nan']);
    const T = p.l('T', [0, 1, 2, 3, 4]);
    const O = p.l('O');
    p.define('run', [], true, [
        set(k, 0),
        repeat(llen(T), [
            // t: NaN, Infinity, -Infinity, a string, a number
            H.if(eq(get(k), 0), [set(t, div(0, 0))]),
            H.if(eq(get(k), 1), [set(t, div(1, 0))]),
            H.if(eq(get(k), 2), [set(t, div(-1, 0))]),
            H.if(eq(get(k), 3), [set(t, 'mango')]),
            H.if(eq(get(k), 4), [set(t, 5)]),
            set(i, 1),
            repeat(llen(A), [
                push(O, add(add(mul(lt(item(A, get(i)), get(t)), 1), mul(gt(item(A, get(i)), get(t)), 2)), mul(eq(item(A, get(i)), get(t)), 4))),
                push(O, add(add(mul(lt(get(t), item(A, get(i))), 1), mul(gt(get(t), item(A, get(i))), 2)), mul(eq(get(t), item(A, get(i))), 4))),
                chg(i, 1)
            ]),
            push(O, add(mul(get(t), get(t)), 1)),
            chg(k, 1)
        ])
    ]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// Case insensitive string equality with constants, including characters with unusual case mappings
// (U+212A KELVIN SIGN lower-cases to "k", U+0130 lower-cases to two characters).
programs.stringEquals = () => {
    const p = new Proj();
    const [i, w] = ['i', 'w'].map(v => p.v(v));
    const S = p.l('S', ['k', 'K', '\u212a', 'c', 'C', 'apple', 'APPLE', 'aPPle', 'apples', '', ' ', 'i\u0307', '\u0130', 'I', 'stra\u00dfe', 'STRASSE', '\u00c9', '\u00e9', 'true', 12, 0, 'kk', '\ud83d\ude00']);
    const O = p.l('O');
    const flags = x => [
        eq(x, 'k'), eq('K', x), eq(x, 'c'), eq(x, 'apple'), eq(x, 'Apple'), eq(x, ''), eq(x, ' '), eq(x, 'i\u0307'),
        eq(x, '\u0130'), eq(x, 'stra\u00dfe'), eq(x, '\u00e9'), eq(x, '\u00c9'), eq(x, 'true'), eq(x, '\ud83d\ude00'), eq(x, 'i')
    ].reduce((acc, e, n) => add(acc, mul(e, Math.pow(2, n))), 0);
    p.define('run', [], true, [
        set(i, 1),
        repeat(llen(S), [
            set(w, join(item(S, get(i)), '')),
            push(O, flags(item(S, get(i)))),
            push(O, flags(get(w))),
            push(O, flags(join(get(w), ''))),
            push(O, flags(H.letter(1, get(w)))),
            chg(i, 1)
        ])
    ]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// x * x where x is a huge number, zero or NaN-producing.
programs.squares = () => {
    const p = new Proj();
    const [x, y, r] = ['x', 'y', 'r'].map(v => p.v(v));
    const O = p.l('O');
    const V = p.l('V', [0, -0.5, 3, 1e200, -1e200, 'abc', '', 'Infinity', '-Infinity', 'NaN']);
    const i = p.v('i');
    p.define('run', [], true, [
        set(i, 1),
        repeat(llen(V), [
            set(x, item(V, get(i))),
            set(y, mul(get(x), 1)),
            set(r, sub(mul(get(y), get(y)), mul(get(x), get(x)))),
            push(O, get(r)),
            push(O, add(mul(get(y), get(y)), mul(get(y), 0))),
            push(O, mul(mul(get(y), get(y)), 0)),
            chg(i, 1)
        ])
    ]);
    p.flag([call(p, 'run', [])]);
    return p;
};

// Broadcasts with constant and computed names, several receivers, and a receiver restarted while running.
programs.broadcasts = () => {
    const p = new Proj();
    const [c, d, name] = ['c', 'd', 'name'].map(v => p.v(v));
    const O = p.l('O');
    const menu = (text, id) => ({op: 'event_broadcast_menu', f: {BROADCAST_OPTION: [text, id]}});
    const hat = (id, text, bid, stmts) => {
        p.blocks[id] = {opcode: 'event_whenbroadcastreceived', next: null, parent: null, inputs: {}, fields: {BROADCAST_OPTION: [text, bid]}, shadow: false, topLevel: true, x: 0, y: 9000};
        p.blocks[id].next = p.stack(stmts, id);
    };
    p.define('run', [], false, [
        repeat(5, [
            {op: 'event_broadcastandwait', in: {BROADCAST_INPUT: menu('tick', 'b1')}},
            push(O, get(c)),
            {op: 'event_broadcast', in: {BROADCAST_INPUT: menu('Tock', 'b2')}},
            {op: 'event_broadcast', in: {BROADCAST_INPUT: menu('Tock', 'b2')}},
            set(name, 'TICK'),
            {op: 'event_broadcastandwait', in: {BROADCAST_INPUT: get(name)}},
            {op: 'event_broadcastandwait', in: {BROADCAST_INPUT: menu('nobody', 'b3')}},
            push(O, get(d))
        ])
    ]);
    p.flag([call(p, 'run', [])]);
    hat('recv1', 'tick', 'b1', [chg(c, 1)]);
    hat('recv2', 'tick', 'b1', [chg(c, 10), repeat(2, [chg(c, 100)])]);
    hat('recv3', 'Tock', 'b2', [chg(d, 1), repeat(3, [chg(d, 10)])]);
    const j = JSON.parse(p.json());
    Object.assign(j.targets[0].broadcasts, {b1: 'tick', b2: 'Tock', b3: 'nobody'});
    return {json: () => JSON.stringify(j)};
};

// Programs whose result legitimately differs between the interpreter and both compilers, or that the
// interpreter can't run as built here (the broadcast blocks have no broadcast variables behind them).
const NO_INTERPRETER = new Set(['rangeStrings', 'broadcasts']);

/**
 * The compilers store a numeric literal typed into a block as a number and the interpreter stores it as the
 * string that was typed, so interpreter results are compared by string value.
 * @param {*} state captured state
 * @returns {*} state with every value converted to a string
 */
const lenient = state => {
    if (!Array.isArray(state)) return state;
    if (state.length === 2 && ['string', 'number', 'boolean'].includes(state[0]) && !Array.isArray(state[1])) {
        return String(state[1]);
    }
    return state.map(lenient);
};

const TTW_VARIANTS = [
    {name: 'ttw', options: {}},
    {name: 'ttw without loop specializations', options: {ttwRangeLoops: false, ttwChunkLoops: false}}
];

for (const name of Object.keys(programs)) {
    for (const warpTimer of [false, true]) {
        test(`ttw kernels: ${warpTimer ? 'warp-timer/' : ''}${name}`, async () => {
            const data = programs[name]().json();
            const tw = await runProject(data, {backend: 'tw', warpTimer, maxSteps: 5000});
            assert.ok(tw.steps < 5000, 'reference run did not finish');
            for (const variant of TTW_VARIANTS) {
                const ttw = await runProject(data, {
                    backend: 'ttw',
                    warpTimer,
                    maxSteps: 5000,
                    setup: vm => vm.setCompilerOptions(Object.assign({backend: 'ttw', warpTimer}, variant.options))
                });
                const diff = compareResults(tw, ttw);
                assert.strictEqual(diff, null, `${variant.name}: ${diff}`);
                assert.deepStrictEqual(ttw.ttwErrors, []);
                assert.strictEqual(ttw.threadsTW, 0, 'some threads fell back to the TW backend');
            }
            if (NO_INTERPRETER.has(name)) return;
            // The interpreter is an independent implementation of the same semantics (it does not use
            // generated code at all), so it also checks the TW reference itself.
            const interpreted = await runProject(data, {backend: 'tw', enabled: false, warpTimer, maxSteps: 50000});
            assert.deepStrictEqual(lenient(interpreted.state), lenient(tw.state), 'interpreter and compiler disagree');
        });
    }
}
