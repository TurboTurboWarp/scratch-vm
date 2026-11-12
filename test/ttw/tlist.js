/* eslint-disable max-len */
/**
 * @fileoverview TList property test (spec 08 T3): random operation sequences compared against TW's compiled
 * list helpers (jsexecute listGet/listReplace/listInsert/listDelete/listContains/listContents/listFind).
 * Known intentional difference: indices of 2^31 and above (TTW floors like Scratch; TW uses `| 0`).
 */
const {test} = require('node:test');
const assert = require('node:assert');
const jsexecute = require('../../src/compiler/jsexecute');
const {TList, syncLists} = require('../../src/ttw/rt/tlist');
const Variable = require('../../src/engine/variable');

const tw = jsexecute.scopedEval('({listGet, listReplace, listInsert, listDelete, listContains, listContents, listFind})');

let seed = 42;
const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
};
const pick = arr => arr[Math.floor(rand() * arr.length)];

const VALUES = [0, -0, 1, 2.5, -3, NaN, Infinity, -Infinity, 1e21, '', '0', '1', '2.5', 'abc', 'ABC', ' ', '\t', 'nan', 'NaN', 'true', 'false', true, false, '-0', '1e3', 'Infinity'];
const INDICES = [1, 2, 3, 0, -1, 1.5, 2.9, NaN, Infinity, -Infinity, '1', '2', '1.7', 'last', 'abc', '', true, false, 100, -0.5, 0.99];

const describe = v => (typeof v === 'number' ? (Object.is(v, -0) ? '-0' : String(v)) : `${typeof v}:${String(v)}`);

const same = (a, b) => (typeof a === typeof b) && (Object.is(a, b) || (typeof a !== 'number' && a === b));

const runSequence = length => {
    const ref = {value: [], _monitorUpToDate: false};
    const tl = new TList();
    const log = [];
    for (let step = 0; step < length; step++) {
        const op = pick(['add', 'add', 'add', 'insert', 'replace', 'delete', 'get', 'get', 'clear', 'find', 'contains', 'contents']);
        const v = pick(VALUES);
        const idx = pick(INDICES);
        log.push(`${op} ${describe(idx)} ${describe(v)}`);
        switch (op) {
        case 'add':
            ref.value.push(v);
            tl.pushSlow(v);
            break;
        case 'insert':
            tw.listInsert(ref, idx, v);
            tl.insertSlow(idx, v);
            break;
        case 'replace':
            tw.listReplace(ref, idx, v);
            tl.setSlow(idx, v);
            break;
        case 'delete':
            tw.listDelete(ref, idx);
            tl.deleteSlow(idx);
            break;
        case 'clear':
            if (rand() < 0.3) {
                ref.value = [];
                tl.clear();
            }
            break;
        case 'get': {
            const a = tw.listGet(ref.value, idx);
            const b = tl.getSlow(idx);
            if (!same(a, b)) return `${log.join('\n')}\nget mismatch: tw=${describe(a)} ttw=${describe(b)}`;
            break;
        }
        case 'find': {
            const a = tw.listFind(ref.value, v);
            const b = tl.indexOf(v);
            if (a !== b) return `${log.join('\n')}\nfind mismatch: tw=${a} ttw=${b}`;
            break;
        }
        case 'contains': {
            const a = tw.listContains(ref, v);
            const b = tl.contains(v);
            if (a !== b) return `${log.join('\n')}\ncontains mismatch: tw=${a} ttw=${b}`;
            break;
        }
        case 'contents': {
            const a = tw.listContents(ref);
            const b = tl.contents();
            if (a !== b) return `${log.join('\n')}\ncontents mismatch: tw=${JSON.stringify(a)} ttw=${JSON.stringify(b)}`;
            break;
        }
        }
        const arr = tl.toArray();
        if (arr.length !== ref.value.length || arr.some((x, i) => !same(x, ref.value[i]))) {
            return `${log.join('\n')}\ncontents differ: tw=[${ref.value.map(describe)}] ttw=[${arr.map(describe)}]`;
        }
        if ((tl.objs.length === 0) !== tl.toArray().every(x => typeof x === 'number')) {
            return `${log.join('\n')}\nPURE invariant broken`;
        }
        if (tl.objs.length !== 0 && tl.objs.length !== tl.len) return `${log.join('\n')}\nobjs length invariant broken`;
    }
    return null;
};

test('TList matches TW list semantics on 10000 random sequences', () => {
    for (let i = 0; i < 10000; i++) {
        const problem = runSequence(1 + Math.floor(rand() * 40));
        if (problem) assert.fail(problem);
    }
});

test('TList round trips through toArray/from/clone', () => {
    const values = [1, 'a', null, undefined, NaN, -0, {}, true, ''];
    const tl = TList.from(values);
    assert.deepStrictEqual(tl.toArray(), values);
    assert.deepStrictEqual(tl.clone().toArray(), values);
    assert.strictEqual(tl.getSlow(3), '', 'null reads as ""');
    assert.strictEqual(tl.getSlow(4), '', 'undefined reads as ""');
});

test('TList externalization (spec 08 T4)', () => {
    const list = Variable.create('id', 'list', Variable.LIST_TYPE, false);
    list._tl.pushSlow(1);
    list._tl.pushSlow('a');
    // Outside code mutates the array it got from .value
    const arr = list.value;
    assert.deepStrictEqual(arr, [1, 'a']);
    assert.strictEqual(list.value, arr, 'same array until the project touches the list');
    arr.push(3);
    syncLists();
    assert.deepStrictEqual(list._tl.toArray(), [1, 'a', 3]);
    // Assignment
    list.value = [4, 5];
    assert.strictEqual(list._tl.getSlow(2), 5, 'slow paths sync first');
    syncLists();
    assert.deepStrictEqual(list._tl.toArray(), [4, 5]);
    // Reading without changing keeps project changes made in between
    const arr2 = list.value;
    list._tl.f64[0] = 9; // a compiled fast path
    syncLists();
    assert.deepStrictEqual(list._tl.toArray(), [9, 5]);
    assert.deepStrictEqual(arr2, [4, 5]);
    // Monitor flag
    list._monitorUpToDate = true;
    list._tl.pushSlow(1);
    assert.strictEqual(list._monitorUpToDate, false);
});

test('TList releases the side table when the last non-number goes away', () => {
    const tl = TList.from(['', 1, 'x']);
    assert.notStrictEqual(tl.objs.length, 0);
    tl.setSlow(1, 5);
    tl.deleteSlow(3);
    assert.strictEqual(tl.objs.length, 0);
    assert.deepStrictEqual(tl.toArray(), [5, 1]);
});
