# 解析Lambda（担当C）

計測テーブルのDynamoDB Streamsを受け、重力成分・ノイズへの対処、衝撃と傾斜の検出、配送品質スコア、位置別の振動集計を行います。

- 結果は計測テーブルとは別の配送評価・地点集計テーブルへ保存する。
- Streamsの再実行時にスコアや測定回数が重複加算されないようにする。
- 閾値・重み・アルゴリズムのバージョンを記録する。
- 約50m区画の切り方、GPS品質の除外基準、配送終了時の確定処理は未確定。
- 路面評価は条件をそろえた相対指標として扱う。

解析ハンドラはanalysis1.py、構成定義はinfra/analysis.yamlです。

解析結果テーブルにはDeliveryTimeIndex（deliveryId / measuredAt、文字列、Projection ALL）を定義し、Dが配送単位で計測を取得します。[既存環境への更新手順](../../docs/deployment/d-query-index-upgrade.md)を参照してください。
