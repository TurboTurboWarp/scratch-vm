// @ts-check
/* eslint-disable no-self-compare, no-undefined */


/**
 * @fileoverview TList: the TurboTurboWarp list representation (spec 03).
 *
 * Element k of a list is:
 *   x = f64[k]; if x === x, the number x.
 *   otherwise o = objs[k]; if o === undefined, a real NaN; otherwise o (string, boolean, ...).
 *
 * Invariant PURE: objs.length === 0 <=> every element is a number. `nonNum` counts the non-number
 * elements; when it drops to 0 the side table is released (objs = EMPTY_OBJS).
 * objs is either the shared frozen EMPTY_OBJS or a PACKED array whose length === len.
 *
 * null/undefined elements (only ever produced by extensions) are read as "" (the same as the
 * TW compiler's `list.value[i] ?? ""`) but are preserved by toArray() through the `exo` side
 * array, which is only consulted by slow paths.
 */

const EMPTY_OBJS = Object.freeze([]);

const EXO_NONE = 0;
const EXO_UNDEFINED = 1;
const EXO_NULL = 2;

/**
 * Lists whose `ext` (externalized JS array) may need to be merged back. See 03 §3.
 * Shared by every VM in the process: syncing a list early is always safe.
 * @type {TList[]}
 */
const extDirty = [];

/**
 * Convert a Scratch list index to a 0-based index.
 * Unlike TW's compiled listIndex this uses Math.floor, so indices above 2^31 behave like Scratch.
 * @param {*} index Scratch index
 * @param {number} length list length (or length + 1 for insertion)
 * @returns {number} 0-based index or -1
 */
const listIndex = (index, length) => {
    if (typeof index !== 'number') {
        if (index === 'last') return length - 1;
        if (index === 'random' || index === 'any') {
            return length > 0 ? (Math.random() * length) | 0 : -1;
        }
        index = +index || 0;
    }
    index = Math.floor(index);
    // Written so that NaN is invalid too.
    return (index >= 1 && index <= length) ? index - 1 : -1;
};

const isNotActuallyZero = val => {
    if (typeof val !== 'string') return false;
    for (let i = 0; i < val.length; i++) {
        const code = val.charCodeAt(i);
        if ((code >= 48 && code <= 57) || code === 9) {
            return false;
        }
    }
    return true;
};

const sameValue = (a, b) => (a === b ? (a !== 0 || 1 / a === 1 / b) : (a !== a && b !== b));

class TList {
    constructor () {
        /** @type {Float64Array} */
        this.f64 = new Float64Array(8);
        /** @type {number} */
        this.len = 0;
        /** @type {any[]} */
        this.objs = EMPTY_OBJS;
        /** @type {number} number of non-number elements */
        this.nonNum = 0;
        /** @type {boolean} */
        this.upToDate = false;
        /** @type {any[]|null} externalized array handed to outside code */
        this.ext = null;
        /** @type {any[]|null} snapshot of ext at externalization; null = ext was assigned by outside code */
        this.extSnap = null;
        /** @type {number[]|null} null/undefined markers, parallel to objs */
        this.exo = null;
        /** @type {any[]|null} last array given to the list monitor */
        this.monitorArray = null;
    }

    // ---------------------------------------------------------------- internals

    /**
     * @param {number} min minimum capacity
     */
    grow (min) {
        let cap = this.f64.length * 2;
        if (cap < min) cap = min;
        if (cap < 8) cap = 8;
        const n = new Float64Array(cap);
        n.set(this.f64.subarray(0, this.len));
        this.f64 = n;
    }

    /**
     * Make objs a real (mutable) array of length len.
     * @returns {any[]} objs
     */
    makeObjs () {
        if (this.objs === EMPTY_OBJS) {
            const o = [];
            for (let i = 0; i < this.len; i++) o.push(undefined);
            this.objs = o;
        }
        return this.objs;
    }

    makeExo () {
        if (this.exo === null) {
            const e = [];
            for (let i = 0; i < this.len; i++) e.push(EXO_NONE);
            this.exo = e;
        }
        return this.exo;
    }

    /**
     * Store v at 0-based index k (k < len).
     * @param {number} k index
     * @param {*} v value
     */
    storeAt (k, v) {
        if (typeof v === 'number') {
            this.f64[k] = v;
            if (this.objs !== EMPTY_OBJS && this.objs[k] !== undefined) this.clearObj(k);
        } else {
            this.f64[k] = NaN;
            const objs = this.makeObjs();
            if (objs[k] === undefined) this.nonNum++;
            if (v === undefined || v === null) {
                objs[k] = '';
                this.makeExo()[k] = v === null ? EXO_NULL : EXO_UNDEFINED;
            } else {
                objs[k] = v;
                if (this.exo !== null) this.exo[k] = EXO_NONE;
            }
        }
    }

    /**
     * Element k (currently a non-number) became a number. Used by compiled fast paths too.
     * @param {number} k index
     */
    clearObj (k) {
        this.objs[k] = undefined;
        if (this.exo !== null) this.exo[k] = EXO_NONE;
        if (--this.nonNum === 0) {
            // Back to PURE: release the side table.
            this.objs = EMPTY_OBJS;
            this.exo = null;
        }
    }

    /**
     * Read 0-based index k (must be in range) with exact semantics.
     * @param {number} k index
     * @returns {*} value
     */
    get (k) {
        const x = this.f64[k];
        if (x === x) return x;
        const o = this.objs[k];
        return o === undefined ? NaN : o;
    }

    /**
     * Read the raw stored value (null/undefined preserved).
     * @param {number} k index
     * @returns {*} value
     */
    getRaw (k) {
        const x = this.f64[k];
        if (x === x) return x;
        const o = this.objs[k];
        if (o === undefined) return NaN;
        if (o === '' && this.exo !== null) {
            const e = this.exo[k];
            if (e === EXO_UNDEFINED) return undefined;
            if (e === EXO_NULL) return null;
        }
        return o;
    }

    // ---------------------------------------------------------------- externalization

    /**
     * Called by ListVariable's `value` getter.
     * @returns {any[]} a JS array that outside code may read and mutate until the next safepoint
     */
    externalize () {
        if (this.ext !== null) return this.ext;
        const arr = this.toArrayRaw();
        this.ext = arr;
        this.extSnap = arr.slice();
        extDirty.push(this);
        return arr;
    }

    /**
     * Called by ListVariable's `value` setter.
     * @param {any[]} arr new contents
     */
    assignExternal (arr) {
        if (!Array.isArray(arr)) arr = [];
        if (this.ext === null) extDirty.push(this);
        this.ext = arr;
        this.extSnap = null;
        this.upToDate = false;
    }

    /**
     * Merge the externalized array back in, if outside code changed it.
     */
    sync () {
        const a = this.ext;
        if (a === null) return;
        const snap = this.extSnap;
        this.ext = null;
        this.extSnap = null;
        if (snap !== null && a.length === snap.length) {
            let same = true;
            for (let i = 0; i < a.length; i++) {
                if (!sameValue(a[i], snap[i])) {
                    same = false;
                    break;
                }
            }
            // Outside code didn't modify the array: our own contents are authoritative.
            if (same) return;
        }
        this.replaceAll(a);
    }

    /**
     * @param {any[]} arr new contents
     */
    replaceAll (arr) {
        this.len = 0;
        this.objs = EMPTY_OBJS;
        this.nonNum = 0;
        this.exo = null;
        if (this.f64.length < arr.length) this.f64 = new Float64Array(arr.length);
        for (let i = 0; i < arr.length; i++) this.pushRaw(arr[i]);
        this.upToDate = false;
    }

    // ---------------------------------------------------------------- slow paths (exact Scratch semantics)

    /**
     * @param {*} v value
     */
    pushRaw (v) {
        const k = this.len;
        if (k === this.f64.length) this.grow(k + 1);
        if (this.objs !== EMPTY_OBJS) this.objs.push(undefined);
        if (this.exo !== null) this.exo.push(EXO_NONE);
        this.len = k + 1;
        this.storeAt(k, v);
    }

    /**
     * @param {*} v value
     */
    pushSlow (v) {
        if (this.ext !== null) this.sync();
        this.pushRaw(v);
        this.upToDate = false;
    }

    /**
     * @returns {number} length (syncing first)
     */
    getLength () {
        if (this.ext !== null) this.sync();
        return this.len;
    }

    /**
     * @param {*} idx Scratch index
     * @returns {*} item or ""
     */
    getSlow (idx) {
        if (this.ext !== null) this.sync();
        const k = listIndex(idx, this.len);
        if (k === -1) return '';
        return this.get(k);
    }

    /**
     * Item read in a numeric context: toNumber applied, NaN -> 0.
     * @param {*} idx Scratch index
     * @returns {number} number
     */
    numSlow (idx) {
        const v = this.getSlow(idx);
        if (typeof v === 'number') return v === v ? v : 0;
        const n = +v;
        return n === n ? n : 0;
    }

    /**
     * @param {*} idx Scratch index
     * @param {*} v value
     */
    setSlow (idx, v) {
        if (this.ext !== null) this.sync();
        const k = listIndex(idx, this.len);
        if (k === -1) return;
        this.storeAt(k, v);
        this.upToDate = false;
    }

    /**
     * @param {*} idx Scratch index (1..len+1)
     * @param {*} v value
     */
    insertSlow (idx, v) {
        if (this.ext !== null) this.sync();
        const k = listIndex(idx, this.len + 1);
        if (k === -1) return;
        this.insertAt(k, v);
        this.upToDate = false;
    }

    /**
     * @param {number} k 0-based index <= len
     * @param {*} v value
     */
    insertAt (k, v) {
        const len = this.len;
        if (len === this.f64.length) this.grow(len + 1);
        this.f64.copyWithin(k + 1, k, len);
        if (this.objs !== EMPTY_OBJS) this.objs.splice(k, 0, undefined);
        if (this.exo !== null) this.exo.splice(k, 0, EXO_NONE);
        this.len = len + 1;
        this.storeAt(k, v);
    }

    /**
     * @param {*} idx Scratch index, or 'all'
     */
    deleteSlow (idx) {
        if (idx === 'all') {
            this.clear();
            return;
        }
        if (this.ext !== null) this.sync();
        const k = listIndex(idx, this.len);
        if (k === -1) return;
        this.deleteAt(k);
        this.upToDate = false;
    }

    /**
     * @param {number} k 0-based index < len
     */
    deleteAt (k) {
        const len = this.len;
        this.f64.copyWithin(k, k + 1, len);
        let wasNonNum = false;
        if (this.objs !== EMPTY_OBJS) {
            wasNonNum = this.objs[k] !== undefined;
            this.objs.splice(k, 1);
        }
        if (this.exo !== null) {
            this.exo.splice(k, 1);
        }
        this.len = len - 1;
        if (wasNonNum && --this.nonNum === 0) {
            // Last non-number removed: back to PURE.
            this.objs = EMPTY_OBJS;
            this.exo = null;
        }
    }

    clear () {
        this.len = 0;
        this.objs = EMPTY_OBJS;
        this.nonNum = 0;
        this.exo = null;
        this.ext = null;
        this.extSnap = null;
        this.upToDate = false;
    }

    /**
     * Same comparison as TW's compiled listFind.
     * @param {*} item value to search for
     * @returns {number} 0-based index or -1
     */
    indexOf (item) {
        if (this.ext !== null) this.sync();
        const len = this.len;
        const f64 = this.f64;
        const itemNumber = +item;
        const itemString = (`${item}`).toLowerCase();
        if (itemNumber !== itemNumber || (itemNumber === 0 && isNotActuallyZero(item))) {
            for (let i = 0; i < len; i++) {
                const value = this.get(i);
                if (value === item || (`${value}`).toLowerCase() === itemString) {
                    return i;
                }
            }
            return -1;
        }
        for (let i = 0; i < len; i++) {
            const x = f64[i];
            if (x === x) {
                if (x === itemNumber) return i;
                continue;
            }
            const value = this.get(i);
            const n = +value;
            if (n !== n || (n === 0 && isNotActuallyZero(value))) {
                if ((`${value}`).toLowerCase() === itemString) {
                    return i;
                }
            } else if (n === itemNumber) {
                return i;
            }
        }
        return -1;
    }

    /**
     * @param {*} item value
     * @returns {boolean} true if the list contains the item (TW listContains)
     */
    contains (item) {
        return this.indexOf(item) !== -1;
    }

    /**
     * Same as TW's compiled listContents.
     * @returns {string} contents
     */
    contents () {
        if (this.ext !== null) this.sync();
        const len = this.len;
        let allSingle = true;
        for (let i = 0; i < len; i++) {
            if ((`${this.get(i)}`).length !== 1) {
                allSingle = false;
                break;
            }
        }
        const sep = allSingle ? '' : ' ';
        let out = '';
        for (let i = 0; i < len; i++) {
            if (i !== 0) out += sep;
            const v = this.getRaw(i);
            out += (v === null || v === undefined) ? '' : v;
        }
        return out;
    }

    /**
     * @returns {any[]} a fresh JS array of the contents (null/undefined preserved)
     */
    toArrayRaw () {
        const len = this.len;
        const out = [];
        for (let k = 0; k < len; k++) out.push(this.getRaw(k));
        return out;
    }

    /**
     * @returns {any[]} a fresh JS array of the contents
     */
    toArray () {
        if (this.ext !== null) this.sync();
        return this.toArrayRaw();
    }

    /**
     * @returns {TList} independent copy (used for clones and duplicated sprites)
     */
    clone () {
        if (this.ext !== null) this.sync();
        const l = new TList();
        l.f64 = this.f64.slice(0, Math.max(8, this.f64.length));
        l.len = this.len;
        l.objs = this.objs === EMPTY_OBJS ? EMPTY_OBJS : this.objs.slice();
        l.nonNum = this.nonNum;
        l.exo = this.exo === null ? null : this.exo.slice();
        return l;
    }

    /**
     * @param {any[]} arr contents
     * @returns {TList} new list
     */
    static from (arr) {
        const l = new TList();
        if (Array.isArray(arr)) l.replaceAll(arr);
        return l;
    }
}

/**
 * Merge back every externalized list. Called at safepoints (03 §3).
 */
const syncLists = () => {
    // A sync never externalizes, so iterating while clearing is safe.
    for (let i = 0; i < extDirty.length; i++) {
        extDirty[i].sync();
    }
    extDirty.length = 0;
};

module.exports = {
    TList,
    EMPTY_OBJS,
    listIndex,
    isNotActuallyZero,
    extDirty,
    syncLists
};
