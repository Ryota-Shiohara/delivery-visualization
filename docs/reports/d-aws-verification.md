# D担当：AWS仮環境の確認記録

2026年10月12日。担当DがAWSコンソールから構築し、公開Web画面・内容・基本操作を確認したと報告。エージェントは公開URLへの読み出しで以下を確認した。AWSリソース一覧や環境変数は直接確認していない。

## 閲覧先

- [公開ダッシュボード](https://delivery-d-999-20261012.s3.us-east-1.amazonaws.com/dashboard/index.html)
- [API health](https://9zzzmshng5.execute-api.us-east-1.amazonaws.com/api/health)

実験用URLであり、Labの停止・終了や設定変更により利用できなくなる場合がある。コードの既定設定にはこのURLを固定せず、config.jsで自分のAPI URLを指定する。

## 読み出し確認

| 対象 | 結果 | 確認した内容 |
| --- | --- | --- |
| S3 dashboard/index.html | HTTP 200 | Content-Type: text/html |
| S3 dashboard/config.js | HTTP 200 | 上記HTTP APIを指定、deploymentはaws |
| GET /api/health | HTTP 200 | status=ok、deployment=aws、dataMode=dynamodb |
| GET /api/deliveries | HTTP 200 | 配送1件、3種類の出所はDynamoDB、各入力1件 |
| GET /api/cells | HTTP 200 | 区画1件、全配送を対象とする集計 |

手順書の仮テーブル名は d-prototype-analysis / d-prototype-summary / d-prototype-cell。実際の環境変数・テーブル名は公開APIからは確認できない。Cの最終テーブル名・キーは別途合意する。

## 実装と再現方法

画面はS3のHTTPSオブジェクトURLで配信。API GatewayのHTTP APIが参照Lambdaを呼び、C形式の3種類のテーブルを読み出す。EC2とCloudFrontは使わない。C共有例と架空デモをリポジトリに含め、ZIPは scripts/package-d-aws.ps1 で再生成できる。API・データ形式は contracts/d-query-prototype.md、AWS手順は docs/deployment/d-dashboard-aws.md を参照。

自動検証：Node.js 24.21.0でローカル/APIアダプターの15項目に成功。Cの型・null・重複ID・ページング・不正入力時の維持・HTTP応答・DynamoDB Scanのページ継続と取得上限を確認。テストは実際のAWSへ書き込まない。

## Cとの統合で残る事項

- Cの解析Lambdaによる自動書き込みと、実測走行データでの表示は未確認。CのサンプルをDynamoDBから読める段階。
- 振動の定義・単位、スコア基準、区画の規則と評価状態をCと確定する。
- 共有例のsummaryは100計測の集計だが、analysisは1件。Dは集計を再計算せず、表示できる件数との差を知らせる。
- 仮取得はScan（各テーブル最大5000件・100ページ）と最大30秒キャッシュ。実験規模を超える場合はQuery・索引・期間指定へ移行する。
- 公開画面/APIは架空サンプル用。実測位置情報を扱う前にB/Cと公開範囲を合意する。
