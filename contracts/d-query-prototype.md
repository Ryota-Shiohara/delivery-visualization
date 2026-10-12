# D参照API・C解析結果：暫定契約

状態：D担当のローカル/AWS仮環境で使用。チーム全員の合意前。入力は2026年10月11日付のC共有案（仮.txt）による。

## 入力

`services/query/local-contract.mjs`で、Cの3種類のキー名をそのまま受け入れる。保存形式とAPIの包み方は分ける。DynamoDBのパーティションキー・ソートキーは未確定。

1. `delivery-analysisDB`：measurementId、deliveryId、measuredAt、qualityScore、vibration、isImpact、tiltDegrees、latitude、longitude、accuracyMeters、speedMetersPerSecond、algorithmVersion。
2. `delivery-summaryDB`：deliveryId、sampleCount、impactCount、avgScore、maxVibration、maxTilt、updatedAt。
3. `delivery-cellDB`：cellId、centerLat、centerLon、sampleCount、avgVibration、maxVibration、impactCount、evalStatus、updatedAt。

日付はタイムゾーン付きISO形式。緯度経度は数値または両方null。傾斜、GPS精度、速度、集計最大傾斜のnullを仮に許容する。null許容はCと要合意。unknownのevalStatusを拒否しない。文字列の数値は通常JSONでは型エラーとし、DynamoDB JSONのNのみ数値へ変換する。measurementId・deliveryId・cellIdは各種類内で一意とする。

## 参照API（GET）

| パス | 応答 |
| --- | --- |
| `/api/deliveries` | `{ items: [{ deliveryId, summary, availableAnalysisCount }], meta }` |
| `/api/deliveries/{deliveryId}?limit=2000&offset=0` | `{ deliveryId, summary, measurements, total, nextOffset, meta }` |
| `/api/cells` | `{ items: [GPS区画集計], scope: "全配送の地点集計", meta }` |

summaryは未受領ならnull。measurementsはmeasuredAt順。limitは1〜30000、初期値2000。offsetは0以上の整数。不存在は404、入力不正は400、想定外は500。エラーは`{ error: "説明" }`。metaに出所・件数・未確定条件を持たせる。

offsetによるページングは、取得した配列に対して行う。AWS仮環境は各テーブル最大5000件・100ページまでのScanと最大30秒キャッシュを使い、その配列から同じ応答を返す。上限超過は413。最終統合ではDynamoDBのキー・索引・Query・継続キーに適した方式、地図範囲検索と閲覧範囲をB/Cと合意する。

## PC内の操作API

- POST `/api/local/import`：`{ type: "analysis" | "summaries" | "cells" | "bundle", records }`。種類別はその種類を置換。一括取り込みは全種類を検証してから変更する。
- POST `/api/local/reset`：`{ mode: "demo" | "c-example" | "empty" }`。
- GET `/api/local/export`：現在の3種類を通常JSONで返す。
- GET `/api/health`：仮環境の応答確認。

PC内の操作APIはAWSへ移さない。サーバーは127.0.0.1のみで待ち受け、取り込みは同じローカル画面から行う。
