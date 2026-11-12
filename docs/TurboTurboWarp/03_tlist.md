# 03 TList — リスト表現

## 1. 構造 (`src/ttw/rt/tlist.js`)
```js
class TList {
  f64   : Float64Array   // 容量 = f64.length。数値要素の実体
  len   : number         // 要素数 (常に >= 0)
  objs  : any[]          // EMPTY_OBJS (共有の凍結空配列) か、長さ == len の PACKED 配列
  upToDate : boolean     // モニター用 (旧 _monitorUpToDate)
  ext   : any[] | null   // 外部化中の JS 配列
}
```
要素 k の値: `x = f64[k]`; `x === x` なら数値 x。そうでなければ `o = objs[k]`; `o === undefined` なら本物の NaN、それ以外は o（文字列/真偽値）。
非数値を格納するとき `f64[k] = NaN; objs[k] = v`。数値を格納するとき `f64[k] = v` かつ `objs !== EMPTY_OBJS` なら `objs[k] = undefined`。
**不変条件 PURE**: `objs.length === 0` ⇔ 非数値要素が 1 つもない。
`objs` は必ず `[]` に `push(undefined)` して作る（`new Array(n)` は HOLEY になるので禁止）。挿入/削除は `f64.copyWithin` と `objs.splice` を両方行う。容量拡張は 2 倍。`clear()` は `len = 0; objs = EMPTY_OBJS`（PURE に戻る。これが「全削除→追加」イディオムを速くする）。

## 2. メソッド（すべて厳密な Scratch 意味論。スローパス兼インタプリタ用）
`getSlow(idx)`, `numSlow(idx)` (toNumber 済み、NaN→0), `setSlow(idx, v)`, `pushSlow(v)`, `insertSlow(idx, v)`, `deleteSlow(idx)`, `clear()`, `indexOf(v)` (TW `listFind` と同じ比較), `contains(v)`, `contents()` (TW `listContents`), `toArray()`, `clone()`, `static from(array)`。
添字変換 `listIndex(idx, len)`: 数値でなければ `'last'` / `'random'|'any'` / `+idx||0`、その後 `Math.floor`、範囲外は -1（**TW の `idx|0` は 2^31 超で誤るので floor を使う**）。挿入は長さ+1 まで有効。
試作実装が `bench/proto/rt.js` にある（出発点として使ってよい。insert/delete/indexOf は未実装）。

## 3. Variable との接続
`Variable` コンストラクタで `type === 'list'` のとき `this._tl = TList.from(value)`。プロトタイプに:
```js
get value()  { return this._tl ? R.externalize(this) : this._value; }   // リストのみアクセサにするため、リスト用サブクラス ListVariable を作りそこに定義する
set value(a) { this._tl.ext = a; runtime.ttw.extDirty.push(this._tl); }
get _monitorUpToDate() / set  → _tl.upToDate
```
スカラー `Variable` は現状のまま（データプロパティ）。**クラスを分ける**こと（スカラーの hidden class を汚さない）。

### 外部化 (externalize)
外部コードが `list.value` を読んだら: `ext = toArray()` を作って返し、`extDirty` に登録。
**再取込みはセーフポイントで行う**: (a) コンパイル済みスレッドを step する直前、(b) 互換レイヤ呼出しから戻った直後、に `if (extDirty.length) R.syncLists()`。sync は `ext` を走査して f64/objs を作り直し `ext = null`。
これによりコンパイル済みコードのリストアクセス経路には外部化の分岐が一切入らない。
制約（文書化する）: `.value` で得た配列参照は「次にプロジェクト側がそのリストを操作するまで」有効。

## 4. VM 内部の書換え（外部化させない）
- `src/blocks/scratch3_data.js` のリスト系プリミティブを全て TList メソッド呼出しに。
- モニター (`getListContents` の `updateMonitor` 経路): `upToDate` が false のときだけ `toArray()`。
- `sb3.js` シリアライズ: `toArray()`。デシリアライズ: `TList.from`。
- `target.duplicateVariable` / クローン生成: `_tl.clone()`（`f64.slice(0, cap)`）。
- `vm.setVariableValue` はセッター経由でよい。

## 5. コンパイル済みコードからのアクセス形（`04 §5` が使う正規形）
以下 `L` は TList を指す `const`、`i` は静的に数値型の添字、`x`,`o`,`k` は関数先頭で宣言した一時。

| 操作 | 文脈 | 出力 |
|---|---|---|
| 読み | 数値 | `((i >= 1 && i <= L.len && (x = L.f64[(i|0)-1], x === x)) ? x : COLD)` |
| 読み | ANY | `((i >= 1 && i <= L.len) ? ((x = L.f64[k = (i|0)-1]) === x ? x : ((o = L.objs[k]) === undefined ? NaN : o)) : "")` |
| 置換 (値が静的 NUM) | | `if (i >= 1 && i <= L.len) { L.f64[k = (i|0)-1] = v; if (L.objs.length !== 0) L.objs[k] = undefined; }` |
| 置換 (値 ANY) | | `if (typeof v === 'number' && i >= 1 && i <= L.len) {同上} else L.setSlow(i, v);` |
| 追加 (値 NUM) | | `if (L.len < L.f64.length && L.objs.length === 0) L.f64[L.len++] = v; else L.pushSlow(v);` |
| 長さ | | `L.len` |
| 全削除 | | `L.clear()` |

- `COLD` は、領域が PURE 版 (`04 §5`) なら定数 `0`、そうでなければ `L.numSlow(i)`。
- 添字が静的に数値でない場合は全体を `typeof i === 'number' ? <上> : L.getSlow(i)`。
- 定数添字 `'last'` は `L.len` を添字として同じ形。添字 1 の delete は `deleteSlow(1)`（特別扱い不要）。
- `upToDate = false` は**変更を含む領域の出口で 1 回**（ループ内で毎回書かない）。フラッシュ集合に含める (`04 §3`)。

## 6. ロード時正規化
`TList.from` に渡す前（プロジェクトロード/スプライト追加時のみ）、要素が文字列 s で `!isNaN(+s) && (+s).toString() === s`、かつ s が全スプライトのコスチューム名・サウンド名に一致しないとき数値 `+s` に置換。これは TW `createConstantInput` が定数に適用している規則と同一。スカラー変数の初期値にも同じ規則を適用。`compilerOptions.normalizeNumericStrings`（既定 true）で無効化可能。実行時に作られた文字列には適用しない。
