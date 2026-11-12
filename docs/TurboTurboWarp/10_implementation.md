# 10 実装状況（実装者による記録）

`00`〜`09` の設計に基づく実装の現状。数値は **Node v24.21.0** と **Chrome 156**（いずれも macOS / ノート PC 1 台）での実測。
ブラウザ計測は scratch-render なし（レンダラ込みの実プロジェクト計測は未実施）。

## 1. 実装マップ

| パート | 仕様 | 実装 | 状態 |
|---|---|---|---|
| A | `backend` オプション、bench 取込み、差分実行 | `runtime.compilerOptions.backend`（既定 `'ttw'`）、`test/ttw-bench/`、`test/ttw/differential.js` | 済 |
| B | TList / ListVariable / VM 内部書換え / 正規化 | `src/ttw/rt/tlist.js`、`src/engine/variable.js`、`src/blocks/scratch3_data.js`、`sb2/sb3.js`、`target.duplicateVariable`、`src/ttw/normalize.js`（`installTargets` から） | 済 |
| B' | TW バックエンドのリスト出力を TList メソッドへ | `src/compiler/jsgen.js` | 済 |
| C | ProgramIR / callgraph(Tarjan) / yields / modref | `src/ttw/program.js`、`src/ttw/analysis/{callgraph,yields,modref}.js` | 済 |
| D | native エミッタ（昇格・フラッシュ・直接呼出し・リスト・比較・mod） | `src/ttw/emit.js` | 済 |
| E | resumable エミッタ（状態機械）+ 互換レイヤ + フレーム | `src/ttw/emit.js`、`src/ttw/rt/helpers.js` (`compatCall`/`compatResume`) | 済 |
| F | スレッド起動・step・broadcast テーブル | `src/ttw/sched.js`、`Thread.tryCompile`、`jsexecute.execute` からの分岐 | 済 |
| G | WT/PT/RT、入口ガード + 汎用ツイン | `src/ttw/analysis/types.js`、`src/ttw/analysis/optimizer.js`、`src/ttw/index.js` (`guardsFor`/`compileUnit`) | 済 |
| H | インライン化 | `src/ttw/analysis/inline.js`（呼出し側文脈で再解析） | 済（文としての呼出しのみ） |
| I | PURE 版分け | `UnitEmitter.emitMaybeVersionedLoop` | 済 |
| J | Pattern Lab / 関数分割 / 無効化 | `test/ttw-bench/patterns/`、`UnitEmitter.emitSplitParts`、エポック方式の無効化 | 済（無効化は粗粒度、§3） |
| K | 範囲解析・チャンク関数・Firefox/Safari | チャンク関数のみ実装（`07 §5`、§4 参照） | 一部 |

## 2. テスト

```
npm test                         # lint + unit + integration + test/ttw (1984 件、全通過)
npm run test:ttw                 # TTW 固有: 差分実行 300 件 + TList 性質 + バックエンド挙動
node test/ttw/differential.js --report [filter]   # 差分レポート（bench: で bench プログラムも）
npm run bench:ttw [-- --warptimer]               # TTW-Bench（TW と TTW を同一 VM で比較）
npm run bench:ttw-patterns                       # Pattern Lab（2.5x 判定、非 0 終了で失敗）
node test/snapshot --update                      # TW / TTW 両方のスナップショット再生成
```

- **T1** 既存テストは既定 `backend: 'ttw'` のまま全通過。スナップショットは TW 用（`backend: 'tw'` 固定、リスト出力の変更分のみ差分）と TTW 用（`__snapshots__/ttw/`、210 件、フォールバック 0）に分離。
- **T2** `test/fixtures/execute` の全 150 プロジェクト × warpTimer on/off で TW と TTW の say 出力列・全変数/リスト（`typeof` 込み・`Object.is`）・`_step` 回数が一致。`Date.now`/`Math.random` を決定化して比較。bench 10 本も一致。TW→TTW のフォールバック 0 件を確認。故意にエミッタを壊すと 149/150 件で検出されることを確認済み（say の無い 1 件のみ非検出）。
- **T3** TList を TW の `listGet/listReplace/listInsert/listDelete/listContains/listContents/listFind`（`jsexecute.scopedEval` で取得した実物）と 1 万系列で突合。この過程で NaN 添字の不具合を 1 件発見・修正。
- **T4** `.value` 経由の外部変更・代入・モニター・セーブ/ロード往復（`test/ttw/tlist.js`, `test/ttw/backend.js`）。
- **T5** `vm.setVariableValue` で program-NUM 変数に `'abc'`, `'5'`, `''`, `true`, `7.5` を入れて汎用ツイン経路で TW と一致。
- **T6** ブロック編集・変数作成でモジュールが再生成されること。
- **T7** TTW スナップショット（上記）。

## 3. 設計からの差分・判断（理由付き）

1. **汎用ツインは即時に「ソース生成」し、コンパイルは V8 の遅延コンパイルに任せる**（`01 §3.4` の遅延スタブの代替）。V8 は呼ばれない関数を前解析しかしないため実質的に遅延。可変束縛と eval を避けられる。
2. **`typeViolation` 逸脱（`02 §4`、未決事項 2）は不要にした**。native 呼出し後の再ロードは `+hK.value` で数値と決め打ちせず、呼出し先の（入口 ANY で計算した）出口サマリ型を使う。よって意味論逸脱点はない。前提は I2（native 実行中に外部コードが変数を書かない）のみ。
3. **入口ガード型**は `WT` そのものではなく `NUMBER_OR_NAN`（WT が NaN を含まなければ `NUMBER` + `v === v` ガード）。スライダー等の外部数値書込みに対して健全にするため。
4. **TW の IROptimizer は手続き呼出しの引数を解析も最適化もしない**（`arguments` 配列を素通り）ことが判明。`TTWOptimizer` で配列を扱うよう拡張し、PT（引数型）が正しく求まるようにした（fib の引数が整数型になる等）。
5. **numeric view sharing（`04 §4`）** は native ユニットで「昇格変数の toNumber を文の前に巻き上げ、再代入まで再利用」する形で実装（呼出しを含む文では行わない）。
6. **インライン化は文としての呼出しのみ**。また「ループを含む手続きを、ループ外の呼出し地点へは展開しない」。単発呼出しの `run` を旗スクリプトへ展開すると、ホットループがチャンク化されずに OSR され（`07 F3`）3〜4 倍遅くなったため。
7. **チャンク関数（`07 §5`、P3 任意）を既定で有効化**（`compilerOptions.ttwChunkLoops: false` で無効）。native ユニットの最上位ループを `fn$cK(th, S, ..., B)` に外出しし、状態は固定形状の箱 `B` で受け渡す。予算は 1, 2, 4, … 4096 反復と倍増。計測で calls 10.7→3.1ms、strlist 1.8→1.4ms、proj3d 7.6→5.9ms、sieve 4.5→3.9ms。`repeat` が 256 未満の定数のループは対象外。
8. **mod 高速路**は `q <= 2^52`（`2^53` では `floor(q/m)*m` が丸められうる）かつ `q >= 0 && (q|0) === q` なら整数 `%`（-0 も厳密）。スローパスも呼出しなしのインライン式。TW の `mod` と境界値・ランダム 20 万件で一致を確認。
9. **リスト `null`/`undefined` 要素**（拡張のみが作る）は読みでは `""`（TW の `?? ""` と同じ）、`toArray()` では保持（サイドテーブル `exo`）。既存テスト「values in lists ... serialized as-is」を満たすため。
10. **TList は非数値要素数 `nonNum` を持ち、0 になると `objs = EMPTY_OBJS` に戻す**（`03 §1` の PURE 不変条件を ⇔ で保つ）。これが無いと、ロード時正規化で全要素が数値になったリストでも PURE 版に入れず、strlist が TW より遅くなった。
11. **外部化**: `.value` の取得時にスナップショットを取り、再取込み時に外部側の変更が無ければ破棄する。これにより「外部が読んだ後でコンパイル済みコードが書いた」場合の消失を防ぐ。配列参照は次にプロジェクトがそのリストを操作するまで有効（`03 §3` の制約どおり）。この制約に依存していた既存テスト `tw_hats_and_events.js` は毎回 `.value` を読み直すよう修正。
12. **ロード時正規化（未決事項 1）は既定 on**（`normalizeNumericStrings: false` で無効）。インタプリタの「リストの内容」ブロックは単一文字判定を TW コンパイラと同じ型非依存規則に揃えた（正規化で結果が変わらないようにするため。TW コンパイラ自身が同じ理由で採用している規則）。
13. **無効化（`01 §4`）はエポック方式**: スプライトのブロックキャッシュ破棄・変数の作成/削除/改名・オリジナルターゲットの追加/削除で全モジュールを次回使用時に再生成。依存事実ごとの細粒度追跡は未実装（正しいが編集時に再コンパイルが多い）。
14. **warp timer の stuck カウンタはユニットごと**（TW はスクリプトごとのファクトリにカウンタを持つ）。これで TW と TTW の yield 位置・`_step` 回数が warpTimer on でも一致する。
15. **resumable ユニット**: 変数昇格は「stuck 時のみ yield する構造化ループ」（warp timer 下の warp ループ）内に限定（ループ (再)進入時ロード、yield・脱出・呼出し・flush-all 点の前にフラッシュ）。一般の状態分解区間では昇格しない。このループは「ループヘルパ」関数 `fn$lK(th, fr)` に外出しし（`for(;;) switch` 内のホットループは Chrome で 3〜5 倍遅かった）、4096 反復ごとにステップ関数へ戻して呼び直す（-1: 完了、-2: 再呼出し、それ以外: ステップ結果）。
16. **スタッククリック・旧コンパイラ互換層を使うスクリプトは TW バックエンド**（設計どおり）。サンプラーの `pc[0]` は TW と同位置に出力。
17. `Sequencer.stepThreads` のプロファイラ分岐の巻き上げは未実施（効果が小さいと判断）。

## 4. 性能（TTW-Bench、Node v24.21.0、7 回の最小値）

注意: 同一マシンでも実行ごとに ±15〜25% 揺れる。下表は 1 回分の実測。

| プログラム | TW (ms) | TTW (ms) | 倍率 | 合格下限 (`08`) |
|---|---|---|---|---|
| mandel | 12.4 | 8.2 | 1.51x | 1.8x ✗ |
| fib | 5.6 | 4.2 | 1.33x | 2.0x ✗ |
| calls | 115.4 | 4.2 | 27.8x（実行により 10〜38x） | 3.5x ✓ |
| sieve | 8.4 | 4.1 | 2.06x | 2.5x ✗ |
| sort | 8.2 | 6.1 | 1.35x | 2.0x ✗ |
| queue | 4.9 | 2.6 | 1.92x | 2.0x ✗（揺れで 2.0〜3.0x） |
| proj3d | 29.5 | 7.6 | 3.87x（3.9〜5.0x） | 3.0x ✓ |
| strlist | 3.0 | 1.8 | 1.68x（1.7〜2.3x） | 4.5x ✗ |
| grid | 28.0 | 6.4 | 4.35x | 5.0x ✗ |
| strings | 0.9 | 0.7 | 1.27x | 1.0x ✓ |
| bcast NPROC=1/20/100 (µs/回) | 0.71 / 1.32 / 3.83 | 0.45 / 0.44 / 0.43 | 1.6x / 3.0x / 8.9x | 8x ✓（NPROC=100） |
| clones (ns/thread-step) | 21.5 | 18.5 | 1.16x | 3x ✗ |
| **幾何平均** | | | **2.56x**（実行により 2.3〜2.7x） | 5.0x ✗ |

warp timer 有効時（エディタ既定、Node）: 全プログラム 1.16x 以上、幾何平均 2.46x。

### Chrome 156（`test/ttw-bench/browser.html`、`performance.now` 分解能 0.1ms）

| | mandel | sieve | fib | calls | sort | strings | strlist | proj3d | grid | queue | bcast1/20/100 | clones | 幾何平均 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| warp timer なし | 1.91x | 2.29x | 1.60x | 1.92x | 0.99x | 1.33x | 3.89x | 3.36x | 4.53x | 2.00x | 1.42/3.05/10.4x | 1.21x | **2.30x** |

- Chrome では TW の calls が 6.9ms（Node では 115ms という Node 固有の外れ値）で、Node の幾何平均を押し上げていた。
- sort は Chrome で 0.99〜1.01x（誤差範囲だが 1.0x を割る回がある）。内側ループが ANY 値をリストへ書くため PURE 版分けの対象外。
- warp timer 有効時の Chrome 計測は、ループヘルパ導入後の個別測定で mandel 17.1→10.7ms（1.6x）。全体を通した計測では先頭の mandel が 0.33x になる回があり、原因（ページ初回実行時の JIT 状態か、非表示ペインでの実行の影響か）は未特定。

Pattern Lab: 全パターンが「チャンク化（TTW の実際の出力形）+ 既定フラグ」「`--no-use-osr`」の両方で生形の 2.5x 以内。単一の長い OSR ループでは一般形リスト読みが 6.7x（`07 F3` そのもの）で、これは情報として表示のみ。

### 受け入れ基準について（正直な評価）

- **「全体幾何平均 ≥ 5.0x」は未達（2.3〜2.7x）**。各プログラムの下限も mandel/fib/sieve/sort/strlist/grid/clones で未達。全プログラムで結果は一致し、どれも 1.0x を下回らない。
- 主因は基準線の違い: 本環境（Node 24）の TW は `00` の表（Node 22）より大幅に速い（mandel 33.5→12.4ms、fib 20.9→5.6ms、strlist 20.1→3.0ms、clones 50→21ns/step）。TTW 側の絶対値は試作値に近いか上回る（mandel 8.2 vs 16.5ms、calls 4.2 vs 8.3ms、strlist 1.8 vs 3.1ms、grid 6.4 vs 8.1ms、proj3d 7.6 vs 7.7ms、broadcast 0.43µs vs 0.11µs は未達）。
- スカラー演算（mandel）は TW の型規則が要求する NaN キャストが残る（`x*x` は型上 Inf·0=NaN を排除できない）。手書き試作はこのキャストを省いていたが、意味論を保つためには必要。
- clones は 1 ステップの大半が `RenderedTarget.setXY` とシーケンサで、バックエンドの差が出にくい。

## 5. 未実施・今後

- Firefox/Safari、および scratch-render 込みの実プロジェクト計測と `00` の表の更新（Chrome での bench 計測のみ実施）。
- Chrome warp timer 計測で mandel が 0.33x になる回がある件の原因調査。
- 範囲解析（`02 §6`、P3）。
- 式としての手続き呼出し（reporter）のインライン化。
- resumable ユニットの状態範囲による関数分割（`07 §4` 後半）。native の分割のみ実装。
- 依存事実ごとの細粒度無効化（`01 §4` の `module.deps`）。
