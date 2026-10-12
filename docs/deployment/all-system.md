# 全システムの構築・更新

リポジトリのルートで実行します。実行者がAWS Academy Labを開始し、ルートの `.env` に現在の認証情報を設定してください。既存の4項目（`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN`、`AWS_REGION`）をそのまま使用します。

必要なものはAWS CLI v2、AWS SAM CLI、Node.js 20以上とnpm、SAMのPythonビルド用Python 3.14です。AWS Academyの既存の `LabRole` を使用し、IAMロールは作成しません。LabRoleにDynamoDB Streamsの読み取りと結果テーブルの読み書き権限が必要です。Labの制限により構築が拒否される場合はCloudFormationのイベントを確認してください。

AWS操作をせず実行内容を確認するコマンド:

```powershell
.\scripts\deploy-all.ps1 -WhatIf
```

全システムを構築・更新するコマンド:

```powershell
.\scripts\deploy-all.ps1
```

次の順で処理します。

1. B: `infra/deploy.ps1` → SAMで受信API、Lambda、計測テーブルを構築。テーブルのStreamsを有効化。
2. C: `infra/analysis.yaml` → SAMで解析Lambda、Streamsトリガー、解析・配送集計・セル集計の3テーブルを構築。
3. D: `scripts/deploy-dashboard.ps1` → Cの出力テーブルを使い、参照API、Lambda、S3、dashboardを構築・配信。サンプルデータは投入しません。
4. A: collectorのS3を構築し、`scripts/deploy-collector.ps1` でテスト・ビルド・配信。Bの出力API URLをビルドに渡します。

最終的なURL、スタック名、テーブル名は画面と `.local/deploy-all/result.json` に出力します。認証情報はこのファイルに含みません。認証情報をプロセス環境に設定するのはAWS CLI/SAM deployの実行中だけです。npm/Viteに `.env` の認証情報を渡しません。

既存環境を更新する場合は、その環境を管理するCloudFormationスタック名を指定します。例:

```powershell
.\scripts\deploy-all.ps1 `
  -IngestionStack delivery-visualization-b `
  -AnalysisStack delivery-visualization-c `
  -DashboardStack delivery-visualization-d `
  -CollectorStack delivery-collector-s3 `
  -ExpectedAccountId 123456789012
```

既定の名前は上記と同じです。リージョンは `.env` の `AWS_REGION` を読み、`-Region` が指定された場合はそれを優先します。別の `.env` を使う場合は `-EnvFile` を指定します。

CloudFrontを使用する場合は、S3配信用とは別のcollectorスタック名を指定してください。

```powershell
.\scripts\deploy-all.ps1 -CollectorHosting cloudfront -CollectorStack delivery-collector-cloudfront
```

途中で失敗した場合はそこで停止します。作成済みのスタックを自動削除しません。`ROLLBACK_COMPLETE` など更新不能のスタックは、イベントで原因を確認してから実行者が復旧してください。Dの既存スタックがprototypeモードの場合はexistingモードへ切り替えられないため、別の `-DashboardStack` を指定します。Bの固定テーブル名・関数名が既に別スタックにある場合も、元のスタック名を指定してください。

Streams接続は `LATEST` から開始し、接続前に保存した計測は再解析しません。collectorで以前のAPI URLを保存済みの場合は画面の送信先を新しいURLへ変更してください。

このスクリプトは各担当の現在の実装を配備します。解析アルゴリズムとAPIの業務処理は変更していません。リポジトリ作業中のエージェントはpush・実デプロイを行わず、上記コマンドは実行者が使用します。
