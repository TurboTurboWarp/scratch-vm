# 09 実装順とパート割り

依存: 矢印の左が先。各パートの完了条件は `08` の該当テスト。

| Phase | パート | 内容 | 仕様 | 依存 | 完了条件 |
|---|---|---|---|---|---|
| P0 | A | bench 取込み、差分実行テスト基盤、`backend` オプション | 08, 01§1 | – | TW 同士で差分 0 |
| P1 | B | TList + ListVariable + VM 内部書換え + 正規化 | 03 | A | T3, T4, 既存テスト（**TW バックエンドのまま** `jsgen` のリスト出力だけ TList メソッド呼出しに暫定変更） |
| P1 | C | ProgramIR + callgraph + yields + modref | 01§3, 02§1-3 | A | 単体テスト（解析結果のダンプ比較） |
| P1 | D | native エミッタ（昇格・フラッシュ・直接呼出し・リスト一般形・比較/ mod 規則）。型は TW の既存解析のみ | 04 (§2,§5 版分け除く) | B, C | 非 yield 手続きを TTW、他は TW で混在実行し T1, T2 |
| P1 | E | resumable エミッタ + compat + frames | 05 | D | 全スクリプト TTW で T1, T2 |
| P1 | F | スレッド起動・step・broadcast テーブル | 06 | E | T1, T2、bcast/clones 下限 |
| P2 | G | WT/PT/RT 型推論、入口ガード+汎用ツイン | 02§4, 04§2 | D | T5、fib/mandel 下限 |
| P2 | H | インライン化 | 02§5 | G | calls/proj3d 下限 |
| P2 | I | PURE 版分け | 04§5 | B, D | sort/strlist/grid 下限 |
| P2 | J | Pattern Lab、関数分割、無効化の依存追跡 | 07§3-4, 01§4 | D | CI |
| P3 | K | 範囲解析、チャンク関数、Firefox/Safari 調整 | 02§6, 07§5 | I | 計測で効果がある場合のみ採用 |

P1 完了時点の見込み: システム系 (broadcast/クローン) とリスト系の大半の利得。P2 で計算カーネルの残り。**P1 完了時にブラウザ実機で実プロジェクトを計測し、`00` の表を実測値で更新すること**。

## 未決事項（実装前に決める人が必要）
1. `normalizeNumericStrings` を既定 on にするか（拡張に渡る値の `typeof` が変わりうる）。
2. `02 §4` の `typeViolation` 逸脱を許容するか（許容しないなら、VM イベントを発火する runtime 呼出しを全て yield 点扱いにする。性能は落ちる）。
3. warpTimer（エディタ既定）時の性能目標。現設計では最内ループのみ構造化を保つ。
