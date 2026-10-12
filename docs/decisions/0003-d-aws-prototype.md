# 0003：D担当のAWS表示用パッケージ

状態：2026年10月12日、担当DがAWSコンソールで構築し、公開画面とDynamoDBの共有例読み出しを確認。自動テストと公開APIの読み出し結果は [確認記録](../reports/d-aws-verification.md) を参照。

S3のHTTPSオブジェクトURLで画面を配信し、HTTP API /api/* からNode.jsの参照Lambdaを呼ぶ。最初はDATA_MODE=demoまたはc-exampleでZIP内の架空サンプルを返す。PCのローカルサーバーに依存しないAWS表示を先に確認する。

次にDATA_MODE=dynamodbとテーブル名を設定し、3種類のC解析結果を取得する。小規模な仮環境ではScanの全ページを取得するが、各テーブル5000件・100ページを上限とし、最大30秒キャッシュする。最終統合でのキー・索引・Query・認証はB/Cと要合意。

AWSの画面ではPC専用のJSON取り込み、リセット、書き出しを非表示にし、AWS表示のラベルを出す。公開設定は画面専用バケットのdashboard/以下のGetObjectに限定する。架空データの仮表示段階でAPIは認証なし。実測データの閲覧範囲は別途設計する。

package-d-aws.ps1はファイルを準備してZIPを作るだけであり、AWS操作・GitHubへのpushは行わない。
