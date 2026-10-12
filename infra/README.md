# AWS構成（担当B中心）

collectorの静的配信はCloudFormationで管理します。それ以外のリソース定義は今後追加します。エージェントはAWSリソースの作成・デプロイを実行しません。

| リソース | 役割 |
| --- | --- |
| API Gateway | 計測受信API・参照API |
| Lambda | ingestion・analysis・query |
| DynamoDB：計測 | センサ・位置情報、Streamsの入力 |
| DynamoDB：配送評価 | 品質スコア・内訳・履歴 |
| DynamoDB：地点集計 | 位置別振動・測定回数・更新日時 |
| S3＋CloudFront | Web画面のHTTPS配信 |
| IAM・ログ設定 | 担当ごとの最小権限・監視 |
| SNS（追加機能） | 重大イベント通知 |

EC2は使用しません。解析が書き込む結果テーブルから同じ解析を起動しない構成にします。

利用可能な授業用AWS権限、認証方式、CORS、テーブルキー・インデックス、保存期間、料金上限、ログ保持期間を確定して設計記録に残します。認証情報・状態ファイルはGitに追加しません。

2026年版手引書に合わせ、リージョンは `us-east-1` を設計の前提とします。AWS Academyでは新しいIAMロールを作成できないため、既存の `LabRole` の利用可否を確認します。構成管理ツールが新規IAMロールを自動作成する場合は、そのまま適用せず既存ロールを参照する構成を検討します。利用できる権限は実際のLabで確認が必要です。

最終統合は代表者のアカウントを想定し、個別検証の設定値を引き継げるようにします。アカウントID・ロールARN・API URL・テーブル名はコードに固定せず、今後の設定ファイルまたは環境変数から渡します。パスワードや一時認証情報は共有しません。

## collectorの配信基盤

### 現在のAWS Academy用：S3だけでHTTPS配信

CloudFrontの作成権限がないLabでは `collector-s3.yaml` を使います。CloudFormationでS3バケットとバケットポリシーを作成します。公開読み取りは配信用の `site/*` に限定し、HTTPSでの取得だけを許可します。匿名の書き込み・バケット一覧取得は許可しません。認証情報や計測データはこの配信用プレフィックスへ置きません。

S3の通常のRESTエンドポイントの `/site/index.html` を開きます。静的ウェブサイトホスティングは設定しません。ルートURLの自動トップページ表示、独自ドメイン、CloudFrontのキャッシュ・配信機能はありません。計測データは端末内の保存を継続します。

リポジトリ直下の `.env` 設定後、次を順に実行します。ラッパーがAWS CLIにUTF-8を指定するので、日本語WindowsでもYAMLを読めます。

```powershell
# リソースを作成しない構文検証
.\scripts\aws-with-env.ps1 -Arguments @('cloudformation', 'validate-template', '--template-body', 'file://infra/collector-s3.yaml')

# 別のスタック名でS3用基盤を作成する
.\scripts\aws-with-env.ps1 -Arguments @('cloudformation', 'deploy', '--template-file', 'infra/collector-s3.yaml', '--stack-name', 'delivery-collector-s3', '--no-fail-on-empty-changeset')

# 作成されたバケット名を取得
$bucket = .\scripts\aws-with-env.ps1 -Arguments @('cloudformation', 'describe-stacks', '--stack-name', 'delivery-collector-s3', '--query', 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue | [0]', '--output', 'text')

# プレビュー後、実際に配信する場合に実行
.\scripts\deploy-collector.ps1 -BucketName $bucket -WhatIf
.\scripts\deploy-collector.ps1 -BucketName $bucket
```

各ステップの成功を確認してから次に進みます。最後に表示されるHTTPS URLをスマホで開き、センサ許可・校正・計測・保存・JSON出力を確認してください。画面更新時も同じ配信スクリプトを使います。

以前の `delivery-collector` が `ROLLBACK_COMPLETE` の場合も、上の新しいスタック名で進められます。失敗スタックと保持バケットは自動で削除しません。不要になったものは別途確認して片付けてください。新しいS3用バケットもスタック削除時に保持されます。

必要な操作はCloudFormationとS3のみです。アカウント全体の公開アクセス制限や組織の制限が追加された場合は、公開ポリシーの設定が拒否されることがあります。

### CloudFrontを利用できるアカウント用

`collector.yaml` で以下をまとめて作成・更新します。

- 非公開S3バケット（名前はCloudFormationが生成、ACL無効、SSE-S3暗号化）
- CloudFront OAC（S3へのリクエストを常に署名）
- CloudFrontキャッシュポリシー（Minimum TTLは0、HTMLの `no-cache` を尊重）
- CloudFrontディストリビューション（HTTPSリダイレクト、`index.html`、標準のCloudFront証明書）
- 上記ディストリビューションだけに読み取りを許可するS3バケットポリシー

PriceClass_200を使います。独自ドメインや証明書、IAMユーザー・ロールは作成しません。バケットポリシーはIAMロールとは別のリソースです。APIや計測データのAWS送信はこのテンプレートに含まれません。

既存の手動作成済みリソースを自動で取り込むものではありません。新規スタックでは別の配信先が作られます。画面のファイルは既存の `scripts/deploy-collector.ps1` でアップロードします。

### AWS Academyでの準備

Labを起動して、最新のAccess Key・Secret Key・Session Tokenをリポジトリ直下の `.env` に設定します。`.env.example` をコピーして編集する具体的な手順は [スクリプトのREADME](../scripts/README.md) を参照してください。AWS CLIは `.env` を自動で読まないため、以下では共通の `aws-with-env.ps1` を使います。

CloudFormation、S3（バケット、暗号化、所有権、パブリックアクセスブロック、バケットポリシー）、CloudFront（ディストリビューション、OAC、キャッシュポリシー）の作成・取得・更新・削除権限が必要です。実際に許可される操作はLabによって異なります。このテンプレートだけで権限制限を回避することはできません。

以下はあなたが実施するコマンドです。リポジトリのルートで実行します。

```powershell
# 認証先が授業用アカウントであることを確認する。
.\scripts\aws-with-env.ps1 -Arguments @('sts', 'get-caller-identity')

# テンプレートのAWS側の構文検証（リソースは作成しない）。
.\scripts\aws-with-env.ps1 -Arguments @('cloudformation', 'validate-template', '--template-body', 'file://infra/collector.yaml')

# 初回作成／同じスタックの更新。完了まで待機する。
.\scripts\aws-with-env.ps1 -Arguments @('cloudformation', 'deploy', '--template-file', 'infra/collector.yaml', '--stack-name', 'delivery-collector', '--no-fail-on-empty-changeset')
```

ラッパーはAWS CLIが失敗すると例外で停止します。リージョンは `.env` の `AWS_REGION`（省略時は `us-east-1`）を使用し、ラッパーの `-Region` でも指定できます。通常は呼び出し元の権限で実行し、IAM作成用の `--capabilities` は不要です。授業で既存LabRoleをCloudFormation実行ロールとして使う指示がある場合のみ、deployのArguments配列に `'--role-arn', '<既存のロールARN>'` を追加します。その場合はCloudFormationが引き受けられる信頼ポリシーと `iam:PassRole` の許可が必要です。LabRoleを使えば必ず成功するとは限りません。

### 出力を受け取ってcollectorを配信する

```powershell
$stackJson = .\scripts\aws-with-env.ps1 -Arguments @('cloudformation', 'describe-stacks', '--stack-name', 'delivery-collector', '--output', 'json')
$stack = ($stackJson -join "`n") | ConvertFrom-Json
$outputs = @{}
foreach ($entry in $stack.Stacks[0].Outputs) {
    $outputs[$entry.OutputKey] = $entry.OutputValue
}

# プレビュー。AWS通信やアップロードは行わない。
.\scripts\deploy-collector.ps1 -BucketName $outputs.BucketName -DistributionId $outputs.DistributionId -WhatIf

# 実際に配信する場合。アカウントIDは実際の12桁の値に置き換える。
.\scripts\deploy-collector.ps1 -BucketName $outputs.BucketName -DistributionId $outputs.DistributionId -ExpectedAccountId '<12桁のアカウントID>'
$outputs.CollectorUrl
```

基盤作成直後は空のバケットなので、ファイル配信が終わるまでURLから画面は開けません。以降、画面だけの変更では配信スクリプトのみ、基盤の変更ではYAMLを編集して同じスタック名でCloudFormationのdeployを再実行します。

### 失敗時と削除時

作成失敗時はCloudFormationの「イベント」で失敗したリソースと理由を確認します。認証期限切れならLabの3項目を更新し、`AccessDenied` なら授業用権限を確認します。初回作成が `ROLLBACK_COMPLETE` になったスタックは、そのまま更新できないため、残存リソースを確認して失敗スタックを削除してから再作成します。

S3には `DeletionPolicy: Retain` と `UpdateReplacePolicy: Retain` を設定しています。スタックを削除・バケットを置換してもバケットとファイルは残り、課金対象になり得ます。CloudFront・OAC・キャッシュポリシー・バケットポリシーはスタック削除時に削除されます。不要になった保持バケットは、必要なファイルを取り出してから手動で空にして削除してください。保持バケットは同名スタックを再作成しても自動で取り込まれません。

参照：[CloudFormation OAC](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudfront-originaccesscontrol.html)、[S3オリジン](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cloudfront-distribution-origin.html)、[CloudFormation deploy](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/deploy.html)。
