# 08 検証とベンチマーク

## 1. 正しさ
- T1 既存 `npm run test:integration` / `test:unit` を `backend: 'ttw'` で全通過。
- T2 **差分実行テスト** `test/ttw/differential.js`: `test/fixtures/execute/*.sb3` と `bench/programs.js` の各プロジェクトを TW / TTW 両方で実行し、(a) 全変数・全リストの最終値（`typeof` 込み、`Object.is` 比較）、(b) `say` 出力列、(c) 終了までの `_step` 回数、を比較。warpTimer on/off 両方。
- T3 TList のプロパティテスト: ランダム操作列 (add/insert/replace/delete/clear、値は数値・NaN・-0・Infinity・文字列・真偽、添字は数値/小数/文字列/'last'/範囲外) を TW の `listGet/listReplace/listInsert/listDelete` (jsexecute) と突き合わせ。1 万列。**既知の意図的差異**: 2^31 超の添字（TTW が Scratch 本家に一致）。
- T4 外部化: 拡張から `list.value.push`、`list.value = [...]`、モニター表示中の変更、セーブ/ロード往復。
- T5 入口ガード失敗経路: スライダー/`vm.setVariableValue` で数値変数に文字列を入れた後の実行結果が TW と一致（汎用ツインが使われる）。
- T6 無効化: ブロック編集・変数追加後に新コードが使われること。
- T7 スナップショット: `test/snapshot` を TTW 出力で別ディレクトリに生成。

## 2. 性能: TTW-Bench
`bench/` を `test/ttw-bench/` に取り込む。`run-tw.js`（実 VM で TW を計測）を `backend` 切替可能にし、`sys-tw.js`（broadcast/クローン）と合わせて次を出力:

| カテゴリ | プログラム | 合格下限 |
|---|---|---|
| スカラー | mandel | 1.8x |
| 呼出し | fib, calls | 2.0x / 3.5x |
| 数値リスト | sieve, sort, queue, proj3d | 2.5x / 2.0x / 2.0x / 3.0x |
| 文字列数値・混在 | strlist, grid | 4.5x / 5.0x |
| 文字列 | strings | 1.0x |
| システム | bcast(NPROC=1,20,100), clones | 8x / 3x |

全体合格: **全プログラムの幾何平均 ≥ 5.0x**、各プログラムが下限以上。計測は 7 回の最小値、既定フラグと `--no-use-osr` の両方を記録（合否は既定フラグ。両者の差が 1.5 倍を超えるプログラムは `07 §5` の対象候補として報告）。
注意: `bench/proto/compiled.js` の数値は手書き出力によるもの。実エミッタでの再現と、ブラウザ (Chrome/Firefox/Safari) + scratch-render 込みの実プロジェクト計測は未実施であり P1 完了時に必ず行う。Firefox/Safari では `07` の F3 が成り立つか不明。

## 3. 再現手順
```
git clone https://github.com/TurboWarp/scratch-vm && cd scratch-vm && npm i --ignore-scripts
# bench/run-tw.js, sys-tw.js の VMDIR を書き換えて
node bench/run-tw.js            # TW 基準値 + gen/*.js に TW の生成 JS
node bench/proto/compiled.js    # 手書き TTW 出力との比較
node bench/proto/sys.js         # スレッド/ broadcast 試作
```
