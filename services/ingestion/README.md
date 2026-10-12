# 受信Lambda（担当B）

API Gatewayからの計測バッチを検証し、計測データ用DynamoDBへ保存します。

- `contracts/` の項目・単位・時刻形式を検証する。
- 計測IDに基づき、再送による重複保存を防ぐ。
- バッチ内の部分成功、再送可能なエラー、配送終了通知の扱いをAPI仕様で決める。
- 認証・認可、最小権限、位置情報を出力しないログを `infra/` と設計する。

## 担当Bの現行プロトタイプ

`lambda_B.py` は `POST /dev/measurements` のJSONオブジェクト1件をDynamoDBへ保存します。上記のバッチ仕様は今後の設計で、現行APIはバッチではありません。`measurementId` が必須で、同じIDの再送は上書きです。collectorは計測項目に加えて `mode`（`device`／`demo`）も送ります。

保存成功時は `{ "message": "saved", "measurementId": "..." }` を返します。不正JSON・不正IDは400、保存失敗は500を返します。全応答に `CORS_ORIGIN` のCORSヘッダーを付けます。計測本文はログに出力しません。保存先は `TABLE_NAME`（省略時は `delivery-testDB`）です。

`infra/template.yaml` の `CollectorOrigin` パラメーターで許可オリジンを指定します（既定 `*`）。SAMがOPTIONSのプリフライト応答を設定し、LambdaがPOST応答のヘッダーを返します。この変更は担当Bのスタックへ反映する必要があります。現行APIには認証・計測Schema全体の検証はまだありません。

AWSに接続しない単体テスト：

```powershell
python -m unittest discover -s services/ingestion -p test_lambda_B.py
```
