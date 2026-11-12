# 05 コード生成: resumable ユニット（yield するスクリプト/手続き）と互換レイヤ

ジェネレータを使わない。計測: ジェネレータ resume 25ns → ステップ関数 3.5ns。

## 1. プロトコル
```js
function r_name(th, fr) -> YIELD(0) | SWITCH(1) | DONE(2)
```
- `fr`: ユニット専用クラス `F_name` のインスタンス `{parent, pc, s0..sN}`。スロットには Scratch 値かコンパイラ一時（ループカウンタ、互換レイヤ引数オブジェクト、待機スレッド配列、タイマ）。引数は `s0..`。
- スレッド: `th.fn`（現在フレームのステップ関数）、`th.frame`、`th.ret`（戻り値受け渡し）。
- トランポリン（`06 §2`）: `do { r = th.fn(th, th.frame); } while (r === SWITCH);`

### resumable 手続きの呼出し（状態 k）
```js
case k: { const nf = new F_callee(fr); nf.s0 = <arg0>; ...; th.frame = nf; th.fn = r_callee; fr.pc = k + 1; return SWITCH; }
case k + 1: /* 戻り値は th.ret */
```
### return
```js
th.ret = <value or "">; th.frame = fr.parent; th.fn = fr.parent.fnRef; return SWITCH;   // スクリプト最上位なら return DONE
```
（各 Frame クラスは `fnRef` をプロトタイプ定数として持つ。）
native → resumable の呼出しは存在しない（yields 解析により呼出し元も resumable）。resumable → native は普通の直接呼出し。

## 2. 状態分割規則
関数全体は `for (;;) switch (fr.pc) { case 0: ... }`。
- **yield 点**: 非 warp ループの末尾、wait、wait until、broadcast and wait、互換レイヤ呼出し、resumable 呼出し、非 warp 自己再帰前、ハット判定後、warpTimer の stuck チェック。
- yield 点を含まない文の並び・if・ループは**構造化 JS のまま**出す。
- if が yield 点を含む: `case a: if (!c) { fr.pc = ELSE; continue; } ...then...; fr.pc = END; continue; case ELSE: ... case END:`
- ループ:
  - 本体内の yield 点が「自分の末尾 yield」だけ → **構造化ループを保つ再入形**:
    ```js
    case 7: fr.s2 = <count>;            // 初期化
    case 8: for (let c = fr.s2; c > 0; c--) { <body>; <flush>; fr.s2 = c - 1; fr.pc = 8; return YIELD; }   // 非 warp
    ```
    warpTimer の場合は `if (R.stuck()) { fr.s2 = c - 1; <flush>; fr.pc = 8; return YIELD; }` を末尾に置き、普段はループが回り続ける。
  - 本体に他の yield 点がある → 完全に状態へ分解（カウンタはスロット、条件判定を `case`、末尾で `fr.pc = HEAD; return YIELD;`）。
- 状態番号とスロット割当は**型解析結果に依存させない**（IR の構造だけで決める）。

## 3. 変数
セグメント（yield 点から次の yield 点まで）ごとに `04 §1,3,4` を適用。全 yield/SWITCH の前に dirty をフラッシュ。再開後の変数入口型は ANY（入口ガード/ツインは使わない）。TW と同じく型状態は yield でクリア。

## 4. 各 yield ブロック
| IR | 出力 |
|---|---|
| `CONTROL_WAIT` | `case a: fr.sT = R.timer(th); fr.sD = Math.max(0, 1000 * secs); runtime.requestRedraw(); [非warp: fr.pc = b; return YIELD;] case b: if (fr.sT.timeElapsed() < fr.sD) { [warp: if (!R.stuck()) continue を使わず] return YIELD; } fr.sT = null;`（warp かつ非 stuck のときは TW 同様ビジーループ: `while (elapsed < D) { if (R.stuck()) {fr.pc = b; return YIELD;} }`） |
| `WAIT_UNTIL` | `case a: if (!<cond>) { [非warp or stuck] return YIELD; }`（条件は毎回再評価、`fr.pc = a` のまま） |
| `BROADCAST_AND_WAIT` | `case a: fr.sW = R.broadcast(...); fr.pc = b; case b: if (R.waitThreads(th, fr.sW)) return YIELD;`。`waitThreads` は TW `waitThreads` の 1 周分（実行中が無ければ false。全員待機中なら `th.status = STATUS_YIELD_TICK`）。**最初の判定は yield せずに行う**（TW と同じ） |
| `HAT_EDGE` / `HAT_PREDICATE` | TW と同じ判定の後、不成立なら `R.retire(th); return DONE;`、成立なら `fr.pc = next; return YIELD;` |
| 非 warp 自己再帰 | 呼出し状態の前に `fr.pc = k; return YIELD;` を 1 つ挟む（引数は yield 前に評価しスロットへ: TW `yieldThenCall` と同順） |

## 5. 互換レイヤ (`rt/compat.js`)
TW `executeInCompatibilityLayer` と同一意味論を状態で表す。
```js
case k:  fr.sA = {INPUT: <v>, FIELD: "x"};            // 引数オブジェクトは 1 回だけ評価（再実行時に再評価しない）
case k1: switch (R.compatCall(th, fr.sA, OPFN, isWarp, blockId, branchInfo|null)) {
           case 1: fr.pc = k1; return YIELD;          // 再実行 (STATUS_YIELD で非warp/stuck、または YIELD_TICK)
           case 2: fr.pc = k2; return YIELD;          // Promise 待ち or 外部停止。結果は後で th.ret
           case 3: continue;                          // STATUS_YIELD かつ warp かつ非 stuck: 即再実行 (fr.pc は k1 のまま)
         }                                            // 0: 完了。結果は th.ret
case k2: R.syncLists(); v = th.ret;                   // useFlags=true のサイトは R.hasResumedFromPromise を TW 同様に扱う
```
`compatCall` の中身: `blockUtility.init(th, blockId, stackFrame)` → 呼出し → (a) thenable: `th.status = PROMISE_WAIT`、then で `th.ret = value(または ''+error); th.status = RUNNING` → 2。(b) status が PROMISE_WAIT/DONE → `th.ret = ''` → 2。(c) YIELD → `status = RUNNING`、`!isWarp || R.stuck()` なら 1、そうでなければ 3。(d) YIELD_TICK → 1。(e) それ以外 → `th.ret = finish(value)` → 0。`finish` と `createBranchInfo`、CONDITIONAL/LOOP ブロックの `while/switch(branch)` 構造は TW と同じ（substack は状態に分解）。
`OLD_COMPILER_COMPATIBILITY_LAYER` を使う拡張があるスクリプトは TTW ではコンパイルせず TW バックエンドへ回す。

## 6. `R.stuck()`
TW `isStuck` と同じ（100 回に 1 回 `sequencer.timer.timeElapsed() > 500`）。カウンタは rt モジュール内 `let`。
