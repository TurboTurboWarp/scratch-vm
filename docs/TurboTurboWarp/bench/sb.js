// Minimal sb3 project builder DSL for benchmarks.
let uid = 0;
const nid = p => `${p}${uid++}`;
class Proj {
  constructor () { this.blocks = {}; this.vars = {}; this.lists = {}; this.procs = {}; this.y = 0; }
  v (name) { if (!this.vars[name]) this.vars[name] = `var_${name}`; return {k: 'var', name, id: this.vars[name]}; }
  l (name, init = []) { if (!this.lists[name]) this.lists[name] = {id: `list_${name}`, init}; return {k: 'list', name, id: this.lists[name].id}; }
  // expression -> input array
  inp (e, parent) {
    if (typeof e === 'number' || typeof e === 'string') return [1, [10, String(e)]];
    const id = this.expr(e, parent);
    return e.bool ? [2, id] : [3, id, [10, '']];
  }
  expr (e, parent) {
    const id = nid('b');
    const b = {opcode: e.op, next: null, parent, inputs: {}, fields: {}, shadow: false, topLevel: false};
    this.blocks[id] = b;
    for (const k in (e.in || {})) b.inputs[k] = this.inp(e.in[k], id);
    for (const k in (e.f || {})) b.fields[k] = e.f[k];
    if (e.mut) b.mutation = e.mut;
    return id;
  }
  stack (stmts, parent) {
    let first = null; let prev = null;
    for (const s of stmts) {
      const id = nid('s');
      const b = {opcode: s.op, next: null, parent: prev || parent, inputs: {}, fields: {}, shadow: false, topLevel: false};
      this.blocks[id] = b;
      for (const k in (s.in || {})) b.inputs[k] = this.inp(s.in[k], id);
      for (const k in (s.sub || {})) { const sid = this.stack(s.sub[k], id); if (sid) b.inputs[k] = [2, sid]; }
      for (const k in (s.f || {})) b.fields[k] = s.f[k];
      if (s.mut) b.mutation = s.mut;
      if (prev) this.blocks[prev].next = id; else first = id;
      prev = id;
    }
    return first;
  }
  flag (stmts) {
    const id = nid('h');
    this.blocks[id] = {opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: (this.y += 500)};
    const f = this.stack(stmts, id); this.blocks[id].next = f;
  }
  declare (name, args, warp) { const proccode = name + args.map(() => ' %s').join(''); const ids = args.map(a => `arg_${name}_${a}`); this.procs[name] = {proccode, ids, args, warp}; }
  define (name, args, warp, stmts) {
    this.declare(name, args, warp); const {proccode, ids} = this.procs[name]; if (typeof stmts === 'function') stmts = stmts();
    const def = nid('d'); const proto = nid('p');
    this.blocks[def] = {opcode: 'procedures_definition', next: null, parent: null, inputs: {custom_block: [1, proto]}, fields: {}, shadow: false, topLevel: true, x: 500, y: (this.y += 500)};
    this.blocks[proto] = {opcode: 'procedures_prototype', next: null, parent: def, inputs: {}, fields: {}, shadow: true, topLevel: false,
      mutation: {tagName: 'mutation', children: [], proccode, argumentids: JSON.stringify(ids), argumentnames: JSON.stringify(args), argumentdefaults: JSON.stringify(args.map(() => '')), warp: String(warp)}};
    this.blocks[def].next = this.stack(stmts, def);
  }
  json () {
    const variables = {}; for (const n in this.vars) variables[this.vars[n]] = [n, 0];
    const lists = {}; for (const n in this.lists) lists[this.lists[n].id] = [n, this.lists[n].init];
    return JSON.stringify({targets: [{isStage: true, name: 'Stage', variables, lists, broadcasts: {}, blocks: this.blocks, comments: {}, currentCostume: 0,
      costumes: [{assetId: 'cd21514d0531fdffb22204e0ec5ed84a', name: 'backdrop1', md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg', dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180}],
      sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null}],
      monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}});
  }
}
// helpers
const bin = (op, a, b) => (x, y) => ({op, in: {[a]: x, [b]: y}});
const H = {
  add: bin('operator_add', 'NUM1', 'NUM2'), sub: bin('operator_subtract', 'NUM1', 'NUM2'),
  mul: bin('operator_multiply', 'NUM1', 'NUM2'), div: bin('operator_divide', 'NUM1', 'NUM2'), mod: bin('operator_mod', 'NUM1', 'NUM2'),
  lt: (x, y) => ({op: 'operator_lt', bool: true, in: {OPERAND1: x, OPERAND2: y}}),
  gt: (x, y) => ({op: 'operator_gt', bool: true, in: {OPERAND1: x, OPERAND2: y}}),
  eq: (x, y) => ({op: 'operator_equals', bool: true, in: {OPERAND1: x, OPERAND2: y}}),
  and: (x, y) => ({op: 'operator_and', bool: true, in: {OPERAND1: x, OPERAND2: y}}),
  or: (x, y) => ({op: 'operator_or', bool: true, in: {OPERAND1: x, OPERAND2: y}}),
  not: x => ({op: 'operator_not', bool: true, in: {OPERAND: x}}),
  math: (fn, x) => ({op: 'operator_mathop', in: {NUM: x}, f: {OPERATOR: [fn, null]}}),
  join: (x, y) => ({op: 'operator_join', in: {STRING1: x, STRING2: y}}),
  letter: (i, s) => ({op: 'operator_letter_of', in: {LETTER: i, STRING: s}}),
  len: s => ({op: 'operator_length', in: {STRING: s}}),
  get: v => ({op: 'data_variable', f: {VARIABLE: [v.name, v.id]}}),
  set: (v, x) => ({op: 'data_setvariableto', in: {VALUE: x}, f: {VARIABLE: [v.name, v.id]}}),
  chg: (v, x) => ({op: 'data_changevariableby', in: {VALUE: x}, f: {VARIABLE: [v.name, v.id]}}),
  item: (l, i) => ({op: 'data_itemoflist', in: {INDEX: i}, f: {LIST: [l.name, l.id]}}),
  llen: l => ({op: 'data_lengthoflist', f: {LIST: [l.name, l.id]}}),
  push: (l, x) => ({op: 'data_addtolist', in: {ITEM: x}, f: {LIST: [l.name, l.id]}}),
  repl: (l, i, x) => ({op: 'data_replaceitemoflist', in: {INDEX: i, ITEM: x}, f: {LIST: [l.name, l.id]}}),
  del: (l, i) => ({op: 'data_deleteoflist', in: {INDEX: i}, f: {LIST: [l.name, l.id]}}),
  clear: l => ({op: 'data_deletealloflist', f: {LIST: [l.name, l.id]}}),
  repeat: (n, body) => ({op: 'control_repeat', in: {TIMES: n}, sub: {SUBSTACK: body}}),
  until: (c, body) => ({op: 'control_repeat_until', in: {CONDITION: c}, sub: {SUBSTACK: body}}),
  if: (c, body) => ({op: 'control_if', in: {CONDITION: c}, sub: {SUBSTACK: body}}),
  ifelse: (c, a, b) => ({op: 'control_if_else', in: {CONDITION: c}, sub: {SUBSTACK: a, SUBSTACK2: b}}),
  arg: name => ({op: 'argument_reporter_string_number', f: {VALUE: [name, null]}}),
  ret: x => ({op: 'procedures_return', in: {VALUE: x}}),
  call: (p, name, args, isReporter) => { const pr = p.procs[name]; const inn = {}; pr.ids.forEach((id, i) => { inn[id] = args[i]; });
    const mut = {tagName: 'mutation', children: [], proccode: pr.proccode, argumentids: JSON.stringify(pr.ids), warp: String(pr.warp)};
    if (isReporter) mut.return = '1';
    return {op: 'procedures_call', in: inn, mut}; }
};
module.exports = {Proj, H};
