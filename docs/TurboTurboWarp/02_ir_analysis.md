# 02 IR と全体解析

IR は TW の `IntermediateScript/Stack/StackBlock/Input` と `InputType` ビット集合を **そのまま使う**。追加するのは解析結果のフィールドだけ。

## 1. コールグラフ (`analysis/callgraph.js`)
ノード = (spriteId, procedureVariant) と各スクリプト。辺 = `PROCEDURE_CALL`。SCC を Tarjan で求め、逆トポロジカル順を以降の解析順とする。

## 2. yields 解析 (`analysis/yields.js`)
`unit.kind ∈ {native, resumable}`。resumable になる条件（TW の `script.yields` と同じ + 伝播）:
- 非 warp のループ / `CONTROL_WAIT` / `WAIT_UNTIL` / `BROADCAST_AND_WAIT` / `COMPATIBILITY_LAYER` / `ADDON_CALL` / `HAT_*` / 非 warp 自己再帰 を含む
- warpTimer 有効時: ループを含む warp ユニット
- resumable なユニットを呼ぶ
SCC 内は不動点。

## 3. mod/ref (`analysis/modref.js`)
各ユニット U に推移閉包で:
- `REF(U)`, `MOD(U)`: 読む/書くスカラー変数 ID の集合（スコープ込みキー `stage:id` / `sprite:id`）
- `LREF(U)`, `LMOD(U)`: リスト同様。`LMODNN(U)`: **数値以外を格納しうる**リスト（格納値の静的型が `NUMBER_OR_NAN` に収まらない store、`insert/replace/add`）
- `EXT(U)`: 外部コードを同期実行しうる（互換レイヤ、addon、`startHats` で executableHat を持つハットが存在するメッセージ）。`EXT` なら MOD/REF は「全て」。

## 4. 書込み型 WT (`analysis/types.js`)
フロー非依存の全プログラム不動点。
- `WT(V)` = 全スプライトの全 `VAR_SET` が V に書く値の型の和 ∪ 現在値の型 (`IntermediateInput.getNumberInputType` / 文字列分類は `createConstantInput` と同規則)。
- 次のいずれかなら `WT(V) = ANY` 固定: `isCloud`、互換レイヤ/拡張ブロックの**フィールドに現れる変数**、`CONTROL_FOR` の対象でない外部書込みが判明したもの。
- `PT(U, k)` = U の第 k 引数に渡される実引数型の和（全呼出しサイト）。addon/外部から呼ばれうる場合 ANY。
- `RT(U)` = 全 `PROCEDURE_RETURN` の値型の和 ∪（return なしで終端に達しうるなら STRING_NAN: `""`）。
- リスト読み `LIST_GET` の型は常に `ANY`（要素型は静的に持たない。動的不変条件 `objs 空` で扱う→`04 §5`）。ただし範囲証明がある場合のみ `NUMBER_OR_NAN | STRING` のまま。
- 反復: 全 WT/PT/RT を 0 (bottom) から開始し、TW の `IROptimizer.analyzeStack` をユニットごとに回して増加がなくなるまで。**変数の入口型**は native ユニットで `WT(V)`、resumable では TW と同じく ANY（yield 後もリセット）。

`program-NUM 変数` := `WT(V) ⊆ NUMBER_OR_NAN`。

### 健全性の根拠
native ユニット実行中は外部コードが走らない (I2) ので、入口で `typeof V.value === 'number'` を確認すれば、以後そのユニットと native 呼出し先が V に書くのは WT により数値のみ。よって入口ガード 1 回で全域 NUM が保証される。
例外: VM/レンダラのイベントリスナ経由で拡張が同期的に変数を書く病的ケース。再ロード時は `+b.value` で読み、非数値なら `R.typeViolation(variable)`（toNumber した値を返し、警告 1 回、その変数を以後 ANY 固定にして dirty 化）。これが唯一の意味論逸脱点であることを明記する。

## 5. インライン化 (`analysis/inline.js`)
対象: native、非再帰 (SCC サイズ 1 かつ自己辺なし)、かつ (IR ノード数 ≤ 40 または 呼出しサイトが 1 箇所でノード数 ≤ 400)。
変換: 引数を一時 `IntermediateInput(TEMP)` に束縛、本体をコピー、`STOP_SCRIPT`/`PROCEDURE_RETURN` はラベル付きブロック `Lk: { ... break Lk; }`、戻り値は一時変数。インライン後に §4 の型解析をそのユニットでもう一度回す（引数型がサイト固有に細る）。
インライン先 1 関数の IR ノード数上限 3000（V8 の最適化対象サイズ対策、`07 §4`）。

## 6. 範囲解析（P2・任意）
`set i to c; repeat (length of L) { ...; change i by 1 }` で本体が L の長さを変えず i への他の書込みがない場合のみ、`item i of L` を「範囲内」とマークする。それ以外は証明しない。
