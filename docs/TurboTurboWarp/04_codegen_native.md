# 04 コード生成: native ユニット（yield しない関数）

入力: 解析済み IR。出力: `function p_name(S, p0, ...) { ... }`。式の生成は **TW `jsgen.js` の `descendInput` を出発点に移植**し、下記の点だけ変える。比較 (`OP_EQUALS/LESS/GREATER`) の型別特殊化は TW の規則を一字一句そのまま使う（テストで検証済みのため）。

## 1. 変数の昇格
ユニット内で参照するスカラー変数 V ごとに JS ローカル `vN` を割り当てる。
- **昇格する**: ループ内で使用がある、または使用が 2 回以上。それ以外は `home.value` を直接読み書き。
- ホーム参照: ステージ変数 `gK`（モジュール定数）、スプライト変数 `S.vK`。関数先頭で `const hK = S.vK;` に取る。
- 関数先頭で `let v0, v1, ...; let x, o, k, t;`（一時）。**型の異なる用途で一時を共有しない**（数値用 `x`、ANY 用 `o`）。

## 2. 入口ガードと汎用ツイン
ユニット内で「書く前に読まれうる」昇格変数（保守的に: ユニット内で読まれる全昇格変数）のうち program-NUM のもの `{A, B, ...}`:
```js
function p_f(S, p0) {
  const hA = gA, hB = S.v3;
  let vA = hA.value, vB = hB.value;
  if (typeof vA !== 'number' || typeof vB !== 'number') return p_f$g(S, p0);
  ...
```
- 高速版では A, B は全域 `WT` 型（数値）として型付け。
- 汎用ツイン `p_f$g` は「全変数の入口型 ANY」で同じ IR をコンパイルしたもの。遅延生成 (`01 §3.4`)。
- program-NUM でない昇格変数はガードなしでロードし、入口型 ANY。
- 引数は `PT` 型。`PT ⊆ NUMBER_OR_NAN` ならキャストなしで数値として使う。

## 3. フラッシュと再ロード
`dirty` = 最後のフラッシュ以降に代入されうる昇格変数の集合（静的・may 解析、制御フロー合流は和）。
- **関数出口**（全 `return`、末尾）: `dirty` 全部を `hK.value = vK`。変更しうるリストに `L.upToDate = false`。
- **native 呼出し `p_g(...)` の前**: `dirty ∩ (REF(g) ∪ MOD(g))` をフラッシュ。**後**: `MOD(g)` 内の昇格変数を再ロード: program-NUM は `vK = +hK.value`、それ以外 `vK = hK.value`（型 ANY に戻す）。
- VM 呼出し（`target.setXY` など副作用のある runtime 呼出し、broadcast）: mod/ref は空として扱う（変数に触れない）。ただし `EXT` 扱いの呼出しは native ユニットに存在しない（存在すれば resumable になっている）。
- フラッシュがループ不変（ループ内でその変数に書込みがない）ならループ前に巻き上げる。

## 4. 数値ビューの共有
ANY 型の昇格変数/引数 v を数値文脈で使うとき、その領域で最初の使用時に `nK = typeof vK === 'number' ? (vK === vK ? vK : 0) : toNum(vK)` を作り、v が再代入されるまで `nK` を再利用する（CAST_NUMBER の値番号付け）。`toNum = v => { const n = +v; return n === n ? n : 0; }`。
`CAST_NUMBER_OR_NAN` は `typeof v === 'number' ? v : +v`。

## 5. リストアクセスと PURE 版分け
基本は `03 §5` の表の「一般形」。加えて **領域版分け**:
ループ L（最外から順に判定し、最初に条件を満たしたループ nest 全体が対象）が次を満たすとき 2 版を出力する。
- 条件: ループ本体（インライン後）に呼出しがない、または呼出し先 g について対象リストが `LMODNN(g)` に入らない。本体内の対象リストへの store は全て静的 NUM 値。
- 出力:
```js
if (L1.objs.length === 0 && L2.objs.length === 0 /* 本体が読む全リスト */) { <PURE 版ループ> } else { <一般版ループ> }
```
- PURE 版では: 数値文脈読みの COLD = `0`、ANY 文脈読みは `(範囲内) ? x(NaN 可の数値) : ""` で型 `NUMBER_OR_NAN | STRING_NAN`、store は `if (範囲内) L.f64[..] = v;` のみ。**PURE 版ループ内に関数呼出しを一切置かない**ことが目的（`07 §2`）。ANY 値をリストへ store する等、呼出しが必要な操作が残るループは版分けしない。
- コードサイズ上限: 版分けによる増分が 1 ユニットあたり IR ノード 1500 を超えたら以降は版分けしない。

## 6. 個別の出力規則（TW からの差分）
| IR | 出力 |
|---|---|
| `OP_MOD`、右辺が正の整数定数 m ≤ 2^32 | `(q = <left>, (q >= 0 && q <= 9007199254740991 && q === Math.floor(q)) ? ((t = q - Math.floor(q / m) * m) < 0 ? t + m : t >= m ? t - m : t) : modSlow(q, m))`（double の `%` は 13ns、これは 3ns） |
| `OP_MOD` その他 | TW と同じ `mod()` 相当をインライン: `((t = a % b), t / b < 0 ? t + b : t)` |
| `OP_EQUALS` 片側が定数文字列 c（数値解釈不可、かつ `c.toLowerCase()` が `infinity`/`-infinity`/`nan` でない） | `(typeof v === 'number' ? false : <TW の文字列比較>)`（TW は数値を毎回文字列化している） |
| `OP_EQUALS/LESS/GREATER` 両側 ANY | `(typeof a === 'number' && typeof b === 'number' && <TW と同じ NaN 条件>) ? a OP b : eqSlow(a, b)` をサイトごとにインライン展開（共有ヘルパ `compareEqual` を経由しない: フィードバック汚染防止） |
| `PROCEDURE_CALL` | `p_x(S, args...)`。戻り値 `RT ⊆ NUM` ならキャスト不要 |
| `VAR_SET` | `vK = <expr>`（昇格時）。クラウド変数は昇格しない |
| `CONTROL_REPEAT` | TW と同じ `for (var a = n; a > 0 (or >= 0.5); a--)`。カウンタは `let` |
| `MOTION_*`, `LOOKS_*`, `PEN_*`, `SENSING_*` | TW と同じ runtime 呼出し。`target` は `S.target`（関数先頭で `const target = S.target`） |
| `EVENT_BROADCAST` | `R.broadcast(th相当なし → S.target.runtime, MSG_ID or name)`（`06 §3`）。定数メッセージは事前解決した ID |
| retire (`STOP_ALL`, clone delete) | native では `throw R.RETIRE` ではなく戻り値プロトコル: native 関数は通常 `""`/値を返すので、retire は TW 同様 `R.retire(); throw RETIRE_MAGIC;` を維持 |

## 7. 手書き参照出力
`bench/proto/compiled.js` に 9 プログラムの期待出力例（手書き）と、対応する TW 出力 (`bench/run-tw.js` 実行で `gen/*.js`) がある。エミッタの出力はこれと同形になること。
