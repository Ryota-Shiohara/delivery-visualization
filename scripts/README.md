# 開発用スクリプト

技術選定後に、サンプル生成、契約検証、ローカルの結合検証などの補助スクリプトを置きます。実行条件と用途をここに記録します。

認証情報の埋め込み、実測位置情報のログ出力、pushは行いません。collectorの配信更新スクリプトはユーザーの依頼により追加しました。エージェントはデプロイを実行しません。

## collectorをS3またはS3＋CloudFrontに配信する

`deploy-collector.ps1` はAWS Academyの一時認証情報をAWS CLI経由で使用します。S3、CloudFront、OACの初回作成は行いません。既存の配信先の更新用です。PowerShell 5.1以降、AWS CLI v2、Node.js 20.19以降の20系または22.12以降が必要です。

初回作成もコードで管理する場合は `infra/collector.yaml` を使います。[基盤の作成とスタック出力の連携手順](../infra/README.md#collectorの配信基盤)に従えば、以下の手動設定の代わりにCloudFormationで作成できます。

現在のAWS Academyでは、CloudFront権限を必要としない `infra/collector-s3.yaml` を使います。[S3だけでHTTPS配信する手順](../infra/README.md#現在のaws-academy用s3だけでhttps配信)に従ってバケットを作成したら、`-DistributionId` を省略して実行します。

```powershell
.\scripts\deploy-collector.ps1 -BucketName '<S3用スタックのバケット名>' -WhatIf
.\scripts\deploy-collector.ps1 -BucketName '<S3用スタックのバケット名>'
```

省略時は `site/` に配信し、CloudFrontへの問い合わせ・キャッシュ無効化を行いません。バケットの実際のリージョンから `/site/index.html` のHTTPS URLを表示します。公開設定はテンプレート側の責務で、配信スクリプトは変更しません。HTML・JS・CSSのみを置いてください。以下のCloudFront向け初回設定はS3用テンプレートを使う場合は不要です。

### 初回の準備

1. Labを起動し、授業用アカウントでS3とCloudFrontが利用できることを確認する。
2. S3バケットはパブリックアクセスブロックを有効にし、CloudFrontの通常のS3オリジン＋OACから読み出せるバケットポリシーを設定する。S3ウェブサイトエンドポイントは使わない。
3. CloudFrontのデフォルトビヘイビアのオリジンをそのバケットにし、オリジンパスは空欄、Default root objectは `index.html`、Viewer protocol policyはHTTPSへのリダイレクトまたはHTTPSのみとする。設定反映を待つ。
4. Labの認証情報表示から最新のAccess Key、Secret Key、Session Tokenの3項目を取得する。新しいIAMユーザーやロールは作らない。

リポジトリ直下の `.env.example` を `.env` にコピーし、Labの3項目を設定します。`.env` はGit対象外です。Labのセッション切れ後は3項目を更新してください。

```powershell
Copy-Item .env.example .env
```

```dotenv
AWS_ACCESS_KEY_ID=<LabのAccess Key>
AWS_SECRET_ACCESS_KEY=<LabのSecret Key>
AWS_SESSION_TOKEN=<LabのSession Token>
AWS_REGION=us-east-1
```

`.env` が既にある場合はコピーで上書きせず、編集してください。`apps/collector/.env` や `VITE_` 付き変数には認証情報を入れません。

読み込みに対応するのは上記4項目、空行、行頭コメント、任意の `export`、値を囲む単一／二重引用符です。変数展開・エスケープ展開・行末コメント・複数行の値は扱いません。必須3項目の欠落、重複キー、不明なキー、形式不正はAWS通信前に停止します。エラーに値は表示しません。

認証情報はAWS CLI実行中だけプロセスの環境変数に設定し、終了時に元の値へ戻します。ファイルの値は `npm ci`・テスト・Viteビルドには渡しません。別の認証情報が既に環境変数にある場合でも、AWS CLIには `.env` の3項目を使用します。

### 実行

リポジトリのルートで実行します。以下のバケット名、ディストリビューションID、アカウントIDを実際の値に置き換えます。

```powershell
# 表示のみ。ビルド、AWS通信、アップロードを行わない。
.\scripts\deploy-collector.ps1 -BucketName '<バケット名>' -DistributionId '<ID>' -WhatIf

# あなたが配信を実施するときに実行する。
.\scripts\deploy-collector.ps1 -BucketName '<バケット名>' -DistributionId '<ID>' -ExpectedAccountId '<12桁のアカウントID>'
```

認証ファイルは起動ディレクトリに関係なくリポジトリ直下の `.env` を使用します。別ファイルは `-EnvFile '<パス>'` で指定できます。リージョンは `-Region` → `.env` の `AWS_REGION` → `us-east-1` の順です。アカウントID確認は省略できますが、指定すると別アカウントへの実行を防げます。

以前の認証方式も `-Profile academy` で使用できます。その場合は `.env` を読み込まず、プロファイルを使用します。`-Profile` と `-EnvFile` は同時に指定できません。

CloudFormationなどのAWS CLIコマンドも同じ `.env` を使うには、`aws-with-env.ps1` 経由で実行します。通常の `aws` コマンドは `.env` を自動で読み込みません。

ラッパーはAWS CLI実行中に `AWS_CLI_FILE_ENCODING=UTF-8` を設定します。日本語Windowsの既定文字コードcp932で、日本語コメントを含むYAMLの読み込みが失敗する問題を防ぎます。終了時には元の設定を復元します。`.env` への追加設定は不要です。

```powershell
.\scripts\aws-with-env.ps1 -Arguments @('sts', 'get-caller-identity')
```

認証読み込みのローカル検証は `.\scripts\tests\aws-env.test.ps1` で実行できます。ダミーの認証情報とAWS CLI・npmのモックを使うため、AWS通信やデプロイは行いません。

認証・配信先確認 → `npm ci` → テスト → ビルド → assets等のアップロード → `index.html`のアップロード → CloudFrontの `/*` 無効化 → 完了待ちの順に進みます。外部コマンドが失敗したら、その時点で停止します。無効化の待機がタイムアウトした場合は、表示されたIDをCloudFrontで確認してください。アップロード済みファイルは自動で戻しません。

ハッシュ付きassetsは1年間キャッシュし、HTML等は `no-cache` にします。CloudFrontのキャッシュポリシーでMinimum TTLを0にするとHTMLの再検証を尊重できます。古いassetsは開いている画面の参照を壊さないよう削除しません。

必要な権限はSTSの本人確認、S3のバケット確認・オブジェクト書き込み、CloudFrontのディストリビューション取得・無効化作成・無効化状態取得です。`AccessDenied` が出た場合はLabでその操作が許可されているか確認してください。OACによる公開閲覧の権限は別途バケットポリシーで設定します。

これはWeb画面の配信のみです。計測データはcollectorの計測中に30件ずつ、または1秒経過時にAPIへ自動送信します。未送信分は画面の「APIへ送信」から手動再送できます。デプロイスクリプトは計測データを送信しません。

## D担当のローカル起動・検証・パッケージ

- `npm run dev:d`：PC内の参照APIと画面を起動。
- `npm run test:d`：C形式・ローカルAPI・AWSアダプターの15項目を検証。
- `npm run package:d`：WindowsでLambda用ZIP・S3画面用ZIP・設定例を `.local/artifacts/` に作成。AWS操作は行わない。
- `node scripts/create-d-samples.mjs`：架空デモとC共有例を再生成。

[利用手順](../D担当_はじめに.md)と[AWS構築手順](../docs/deployment/d-dashboard-aws.md)を参照。Dの画面はcollectorのビルドや依存パッケージと独立している。

## DのAWS構築スクリプト

deploy-dashboard.ps1はDのS3配信・HTTP API・参照Lambdaを構築して画面を公開します。既存のCテーブル接続または仮テーブル作成を選べます。認証はaws-with-env.ps1を共用します。[実行手順](../docs/deployment/d-dashboard-automated.md)とscripts/tests/dashboard-deploy.test.ps1を参照。WhatIf指定時はAWS通信・ローカル生成を行いません。

配送単位のQuery・ページ取得・UI整理とCの索引追加は [既存環境の更新手順](../docs/deployment/d-query-index-upgrade.md) を参照してください。

## 過去の衝撃レコードにGSI用属性を一括付与する

`backfill-impact-index.ps1` は既定で `.local/deploy-all/result.json` の `AnalysisTableName`・`Region`・`AccountId` を読み、ルートの `.env` で認証します。3テーブルのうち解析結果のみを対象にし、集計テーブルは変更しません。PowerShell 7で検証しています。

```powershell
# AWSを読み取り、更新対象件数を確認する（書き込まない）
pwsh -NoProfile -File scripts/backfill-impact-index.ps1

# isImpact=true の過去レコードに impactDeliveryId=deliveryId を追加する
pwsh -NoProfile -File scripts/backfill-impact-index.ps1 -Apply

# 別の構築結果ファイルを使う
pwsh -NoProfile -File scripts/backfill-impact-index.ps1 -ResultFile '<result.jsonのパス>'
```

全ページを順次Scanします。通常レコードと付与済みレコードは更新せず、属性が不足した衝撃は `Invalid` に計上します。位置情報・レコードIDはログに出しません。スキャンはテーブル全体を読むため、その分の読み取り料金が発生します。

更新直前にも衝撃判定・配送ID・計測日時・索引用属性の未付与を条件式で確認します。同時更新などによる条件不一致やAWSエラーでは停止します。完了済みの更新は保持され、再実行すると付与済みをスキップします。異なる索引用属性が既にある場合は上書きせず停止します。Scan全体はスナップショットではないため、計測停止後の実行が確実です。

これは**索引用属性の補完のみ**です。GSIの作成、Lambda・画面のデプロイ、新規計測への属性追加は行いません。衝撃専用GSIはパーティションキー `impactDeliveryId`（S）、ソートキー `measuredAt`（S）で別途作成します。既存の `DeliveryTimeIndex` は変更しません。

AWS通信なしの検証：`pwsh -NoProfile -File scripts/tests/impact-backfill.test.ps1`。

更新は最大10件ずつの条件付きトランザクションで実行します。各まとまりは全件成功か全件失敗となり、成功済みのまとまりは保持されます。通常の書き込みより書き込み容量を使います。[AWSの条件付き一括更新](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_ConditionalBatchUpdate.html)を参照してください。
