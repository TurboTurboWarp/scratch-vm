// Prototype of the TurboTurboWarp runtime pieces that matter for performance.
'use strict';
const EMPTY_OBJS = Object.freeze([]);
class TList {
  constructor () { this.f64 = new Float64Array(8); this.len = 0; this.objs = EMPTY_OBJS; this.ext = null; this.upToDate = false; }
  // ---- slow paths (out of line) ----
  grow (min) { let cap = this.f64.length * 2; if (cap < min) cap = min; const n = new Float64Array(cap); n.set(this.f64.subarray(0, this.len)); this.f64 = n; }
  pushSlow (v) {
    if (this.len < 0) this.sync();
    if (this.len === this.f64.length) this.grow(this.len + 1);
    if (typeof v === 'number') { this.f64[this.len] = v; if (this.objs !== EMPTY_OBJS) this.objs.push(undefined); } else { this.f64[this.len] = NaN; this.objsFor()[this.len] = v; }
    this.len++; this.upToDate = false;
  }
  objsFor () { if (this.objs === EMPTY_OBJS) { const o = []; for (let i = 0; i < this.len; i++) o.push(undefined); this.objs = o; } if (this.objs.length === this.len) this.objs.push(undefined); return this.objs; }
  getSlow (idx) { // any-context, exact Scratch semantics for arbitrary idx
    if (this.len < 0) this.sync();
    const k = listIndex(idx, this.len); if (k === -1) return '';
    const x = this.f64[k]; if (x === x) return x; const o = this.objs[k]; return o === undefined ? NaN : o;
  }
  numSlow (idx) { const v = this.getSlow(idx); if (typeof v === 'number') return v === v ? v : 0; const n = +v; return n === n ? n : 0; }
  setSlow (idx, v) {
    if (this.len < 0) this.sync();
    const k = listIndex(idx, this.len); if (k === -1) return;
    if (typeof v === 'number') { this.f64[k] = v; if (this.objs !== EMPTY_OBJS) this.objs[k] = undefined; } else { this.f64[k] = NaN; if (this.objs === EMPTY_OBJS) { const o = []; for (let i = 0; i < this.len; i++) o.push(undefined); this.objs = o; } this.objs[k] = v; }
    this.upToDate = false;
  }
  clear () { this.len = 0; this.objs = EMPTY_OBJS; this.ext = null; this.upToDate = false; }
  sync () { const a = this.ext; this.ext = null; this.len = 0; this.objs = EMPTY_OBJS; for (let i = 0; i < a.length; i++) this.pushSlow(a[i]); }
  toArray () { const out = new Array(this.len); for (let k = 0; k < this.len; k++) { const x = this.f64[k]; if (x === x) out[k] = x; else { const o = this.objs[k]; out[k] = o === undefined ? NaN : o; } } return out; }
  static from (arr) { const l = new TList(); for (let i = 0; i < arr.length; i++) l.pushSlow(arr[i]); return l; }
}
const listIndex = (index, length) => { if (typeof index !== 'number') { if (index === 'last') return length - 1; if (index === 'random' || index === 'any') return length > 0 ? (Math.random() * length) | 0 : -1; index = +index || 0; } index = Math.floor(index); return (index < 1 || index > length) ? -1 : index - 1; };
const isNotActuallyZero = val => { if (typeof val !== 'string') return false; for (let i = 0; i < val.length; i++) { const code = val.charCodeAt(i); if ((code >= 48 && code <= 57) || code === 9) return false; } return true; };
const toNum = v => { const n = +v; return n === n ? n : 0; };
const eqSlow = (v1, v2) => { const n1 = +v1; if (n1 !== n1 || (n1 === 0 && isNotActuallyZero(v1))) return ('' + v1).toLowerCase() === ('' + v2).toLowerCase(); const n2 = +v2; if (n2 !== n2 || (n2 === 0 && isNotActuallyZero(v2))) return ('' + v1).toLowerCase() === ('' + v2).toLowerCase(); return n1 === n2; };
const gtSlow = (v1, v2) => { let n1 = +v1; let n2 = +v2; if (n1 === 0 && isNotActuallyZero(v1)) n1 = NaN; else if (n2 === 0 && isNotActuallyZero(v2)) n2 = NaN; if (n1 !== n1 || n2 !== n2) return ('' + v1).toLowerCase() > ('' + v2).toLowerCase(); return n1 > n2; };
const ltSlow = (v1, v2) => { let n1 = +v1; let n2 = +v2; if (n1 === 0 && isNotActuallyZero(v1)) n1 = NaN; else if (n2 === 0 && isNotActuallyZero(v2)) n2 = NaN; if (n1 !== n1 || n2 !== n2) return ('' + v1).toLowerCase() < ('' + v2).toLowerCase(); return n1 < n2; };
const modSlow = (n, m) => { let r = n % m; if (r / m < 0) r += m; return r; };
class Variable { constructor (id, v) { this.id = id; this.name = id; this.type = ''; this.isCloud = false; this.value = v; } }
module.exports = {TList, EMPTY_OBJS, listIndex, toNum, eqSlow, gtSlow, ltSlow, modSlow, Variable};
