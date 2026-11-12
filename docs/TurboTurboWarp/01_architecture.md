# 01 アーキテクチャ

## 1. ディレクトリ
```
src/compiler/            既存 (TW)。残す。compilerOptions.backend === 'tw' で使用
src/ttw/
  index.js               compileSprite(target) / getScript(target, topBlockId)
  irgen.js               TW irgen を流用 (ScriptTreeGenerator はほぼそのまま)
  program.js             全スプライトの IR を保持する ProgramIR、解析のドライバ
  analysis/{callgraph,modref,types,yields,inline}.js
  lower.js               IR → LIR (昇格・フラッシュ・ガード挿入・状態分割)
  emit-native.js         LIR → JS (非 yield)
  emit-resumable.js      LIR → JS (状態機械)
  rt/{tlist,helpers,compat,frames}.js   実行時ライブラリ
  sched.js               スレッド起動・broadcast テーブル・step ループ
```
`runtime.compilerOptions` に `backend: 'ttw' | 'tw'` を追加（既定 `'ttw'`、失敗時は `'tw'` → インタプリタの順でフォールバック）。

## 2. コンパイル単位
- **単位 = スプライト (sprite、クローン共有)**。1 スプライト = 1 回の `new Function`。
- 生成モジュールの形:
```js
(function ttw$Sprite1(R, G) {          // R: rt ライブラリ, G: ステージの束縛 (グローバル変数/リスト)
  "use strict";
  const {toNum, eqSlow, ltSlow, gtSlow, modSlow, YIELD, SWITCH, DONE /*...*/} = R;
  const g0 = G.v[0], g1 = G.v[1];      // ステージ Variable オブジェクト (スカラー)
  const gl0 = G.l[0];                  // ステージ TList
  class Self { constructor(target){ this.target = target; this.v0 = target.variables["id"]; this.l0 = target.variables["id2"]._tl; /*...*/ } }
  function p_rot(S, p0, p1, p2) { ... }            // 非 yield 手続き (native)
  function p_rot$g(S, p0, p1, p2) { ... }          // 汎用ツイン。初回呼出し時に遅延コンパイルするスタブ
  function r_loop(th, fr) { ... }                  // yield する手続き/スクリプト (resumable)
  class F_r_loop { constructor(parent){ this.parent = parent; this.pc = 0; this.s0 = 0; /*...*/ } }
  return {Self, scripts: {"topBlockId": {index: 0, native: fn|null, step: r_xxx|null, Frame: F_xxx|null, executableHat: bool}}};
})
```
- `S` (Self) はターゲットごとに 1 個（クローン生成時に `new Self(clone)`、`target._ttwSelf` に保持）。フィールドは固定順で単相。
- ステージ自身のスクリプトは `S` を使わず `g*` 定数を直接参照。
- 手続きはモジュール内 `function` 宣言。呼出しは `p_rot(S, a, b, c)` の直接呼出し（`thread.procedures[...]` 禁止）。
- warp/非 warp の変種は TW と同じく別関数 (`p_x$W`, `p_x$Z`)。

## 3. コンパイルの流れ
1. `ProgramIR.build(runtime)`: 全 original ターゲットの全トップブロックと全手続きを TW の `ScriptTreeGenerator` で IR 化（安い。JS 生成はまだしない）。
2. 全体解析 (`02`): コールグラフ → yields → mod/ref → 書込み型 → 引数/戻り値型 → インライン判定。
3. スプライトごとに遅延で `lower` → `emit` → `new Function`（そのスプライトの最初のスレッド起動時、または `runtime.precompile()`）。
4. 汎用ツインはスタブ: `function p$g(...){ return R.lazyTwin(MODULE_ID, "p")(...) }`。初回のみコンパイルし、以後モジュールの可変束縛 `let p$g_impl` を差し替える。

## 4. 無効化
- TW と同じトリガ (`blocks.resetCache()`、変数の追加/削除/改名、コメント変更) で **そのスプライトのモジュールを破棄**し `ProgramIR` を dirty にする。
- 全体解析の結果のうちそのモジュールが依存した事実（グローバル変数の書込み型、他スプライトから呼ばれない等）を `module.deps` に記録。再解析で事実が変わったモジュールも破棄。
- 実行中スレッドは旧コードで走り続ける（TW と同じ）。旧 `Self` も保持。

## 5. 外部互換
- `Variable.value`（スカラー）は従来どおりのデータプロパティ。**変更しない**。
- リスト変数だけ `value` をアクセサにし実体を `variable._tl` (TList) に置く (`03`)。
- `thread.isCompiled`, `thread.generator` を参照する外部コードのため `thread.isCompiled = true` は維持、`generator` は `null`。
- サンプラー (`pc[0] = ...`) とデバッグ (`runtime.debug`) は TW と同位置に出力。
