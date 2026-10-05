# 共通データ・API契約（全員）

実装前にこのディレクトリの契約を合意し、変更は送信側・受信側・解析側・表示側で確認します。

`schemas/measurement.schema.json` は1件の計測データの暫定JSON Schema、`data/samples/measurement.json` はその架空サンプルです。バッチ形式・APIパス・結果形式はまだ定義していません。

| 項目 | 暫定ルール |
| --- | --- |
| schemaVersion | 契約のバージョン。初期案は `0.1.0` |
| measurementId | 計測ごとに一意。再送時も同じID |
| deviceId | 匿名化した端末ID |
| deliveryId | 配送を識別するID |
| measuredAt | UTCのISO 8601文字列（末尾Z） |
| acceleration | x・y・z、単位m/s²。重力を含むかを含め方式を明示 |
| tiltDegrees | 開始時の基準姿勢からの傾斜角、単位度 |
| position | GPS未取得はnull。緯度・経度、精度m、速度m/s（未取得はnull） |

傾斜も未取得時はnullとします。加速度とGPSの取得頻度が異なるため、位置には取得時刻を持たせます。古いGPS位置をどこまで使用するかは別途合意します。

次に定義する契約：

1. 配送開始・終了、校正・移動手段・固定方法などのメタデータ。
2. バッチ送信、部分成功、重複計測、認証・認可、エラーと再送ルール。
3. 配送評価、スコア内訳、時系列、路面区画の結果Schema。
4. 配送一覧・詳細・地図範囲検索のAPI、ページングと件数上限。
