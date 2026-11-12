# 06 ランタイム: スレッド・broadcast・クローン

## 1. スレッド起動（`Thread.prototype.tryCompile` の置換）
```js
const self = target._ttwSelf || (target._ttwSelf = new module.Self(target));
const sc = module.scripts[topBlockId];
thread.isCompiled = true; thread.ttw = sc; thread.self = self;
if (sc.step) { thread.frame = new sc.Frame(null); thread.fn = sc.step; }
```
**手続きクロージャの生成をしない**（TW はここで依存手続き全部を生成: broadcast 1 回 2.5〜10.7µs の主因）。stackClick スレッドは従来どおり個別コンパイル（TW バックエンド）でよい。

## 2. step（`jsexecute.execute` の置換、`Sequencer.stepThread` から呼ぶ）
```js
if (extDirty.length) R.syncLists();
R.current = thread;                               // blockUtility 等が参照
try {
  if (sc.native) { sc.native(thread.self); R.retire(thread); }
  else { let r; do { r = thread.fn(thread, thread.frame); } while (r === 1); if (r === 2) R.retire(thread); }
} catch (e) { if (e !== RETIRE_MAGIC) throw e; }
```
`Sequencer.stepThreads` 自体のループ構造・ステータス遷移・WORK_TIME 判定は**変更しない**（実行順の互換性のため）。ただしプロファイラ分岐 (`runtime.profiler !== null`) をループ外で 1 回判定し、プロファイラ無し用のループ本体を別関数にする。

## 3. broadcast テーブル (`sched.js`)
- `receivers: Map<UPPERCASE_NAME, Array<{target, topBlockId, sc}>>` を、ターゲット追加/削除（クローン生成・削除）とブロックキャッシュ無効化時に更新。順序は `allScriptsByOpcodeDo` と同じ（`executableTargets` の逆順 × スクリプト順）。クローン生成時は元スプライトのエントリ位置規則に従い再構築（単純に dirty フラグで次回 broadcast 時に全再構築でよい: クローン増減のないフレームでは O(受信者数)）。
- `R.broadcast(runtime, nameOrId)`: 定数メッセージはコンパイル時に配列への参照を解決（`module` に `bc[k]` として束縛、再構築時は配列の中身を入替え）。動的名は `String(name).toUpperCase()` で Map 参照。
- 起動は `restartExistingThreads` 意味論: 既存スレッドは `target._ttwLive[sc.index]`（スクリプトごとのスロット）で O(1) に発見し、TW `_restartThread` と同じく `runtime.threads` の同位置に差し替える。**`threadMap` と文字列キー (`getIdFromTargetAndBlock`) は互換のため維持するが、TTW 経路では参照しない**（キーは `sc` に事前計算して保持し、連結を毎回しない）。
- 戻り値は起動したスレッド配列（broadcast-and-wait 用）。`startHats` の他のハット（キー入力等）は既存実装のまま。

## 4. クローン
`new Self(clone)` はフィールド数ぶんの `target.variables[id]` 参照のみ。リストは `_tl.clone()`。`control_start_as_clone` の起動は既存 `startHats` 経由でよい。

## 5. retire / stop
`R.retire(thread)` = `sequencer.retireThread` + `thread.frame = null; thread.fn = null; target._ttwLive[idx] = null`（自分が登録者のときのみ）。`stopForTarget`, `stopAll`, `_stopThread` からも `_ttwLive` を掃除。

試作: `bench/proto/sys.js`（broadcast 110ns、thread-step 9.4ns）。
