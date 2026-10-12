# D担当のAWS環境を1回の実行で構築する

Windows PowerShellから、代表者のAWS AcademyアカウントへD担当の環境を作成・更新する。構築後はAWSで動作し、PCのローカルサーバーは不要。S3のHTTPSオブジェクトURLから誰でも画面を開ける。EC2・CloudFront・新規IAMロールは使わない。

## 構築するもの

| 定義・スクリプト | 内容 |
| --- | --- |
| `infra/dashboard-storage.yaml` | 画面配信用S3、dashboard/のHTTPS読み取りポリシー、非公開のLambda ZIP保存用S3 |
| `infra/dashboard.yaml` | 参照Lambda、HTTP API、CORS、呼び出し許可、7日保持のログ、必要に応じて仮テーブル3つ |
| `scripts/deploy-dashboard.ps1` | 事前確認、パッケージ、構築、サンプル登録、画面アップロード、公開URLとAPI確認 |
| `scripts/aws-with-env.ps1` | Aと共用する認証・リージョン指定。一時認証情報はAWS CLIの実行中だけ設定 |

1回のスクリプト実行で、`<StackName>-storage` と `<StackName>-backend` の2つのCloudFormationスタックを管理する。先に保存先を作り、そこにZIPを置いてLambdaを作成するために分けている。ZIPはSHA256を含むキーで保存し、コードの変更もCloudFormationへ伝える。

画面用S3の公開対象は `dashboard/*` の `GetObject` だけ。LambdaのZIP、DynamoDB、認証情報は画面用プレフィックスに置かない。参照APIは今回の公開実験用で認証なし。Cの実測位置情報を接続するときは、チームで公開範囲を確認する。

## 初回だけ用意するもの

1. このリポジトリを構築用PCへ取得し、PowerShellでリポジトリ直下へ移動する。
2. AWS CLI v2とNode.js 20以上をインストールする。SAM CLI、npm依存のインストール、ローカルWebサーバーの起動は不要。
3. AWS AcademyのLabを起動する。
4. `.env.example` を `.env` にコピーし、LabのAWS Access Key、Secret Key、Session Tokenを設定する。`.env` はGit対象外。Labの認証が切れたら3項目を更新する。認証情報を画面のconfig.jsへ記載しない。
5. リージョンは原則 `us-east-1`。既存の `LabRole` を参照する。CloudFormation、S3、HTTP API、Lambdaと結果テーブルの読み取りに必要な権限は利用するLabによる。

すでにAWS CLIのプロファイルを使っている場合は `-Profile academy` を付ければ `.env` を読まない。別の認証ファイルには `-EnvFile <場所>` を指定する。両方同時には指定しない。

## 方法1：Dだけの確認用テーブルとサンプルを作る

変更を行わず予定だけ確認する：

```powershell
.\scripts\deploy-dashboard.ps1 -TableMode prototype -WhatIf
```

構築する：

```powershell
.\scripts\deploy-dashboard.ps1 -TableMode prototype
```

analysis / summary / cellの3テーブルがオンデマンドで作成され、Cから共有された架空のサンプルを各1件登録する。物理テーブル名はCloudFormationが自動生成し、末尾の実行結果に表示する。同じサンプルIDがある場合は上書きしない。空の仮テーブルから始める場合は `-SkipSampleData` を付ける。

サンプルのsummaryは100件の集計だが、analysisは1件のみ。画面の件数差の表示は想定どおりで、実際のC解析が100件行われたことを示すデータではない。

## 方法2：Cが用意した既存テーブルへ接続する

代表者とCで、同じAWSアカウント・リージョン内の実際のテーブル名を確認する。以下の名前は共有案なので、実際の名前に置き換える。

```powershell
.\scripts\deploy-dashboard.ps1 `
  -StackName delivery-visualization-d-team `
  -TableMode existing `
  -AnalysisTableName delivery-analysisDB `
  -SummaryTableName delivery-summaryDB `
  -CellTableName delivery-cellDB
```

このモードは既存テーブルがACTIVEであることを確認して参照Lambdaへ名前を渡す。テーブル作成・項目登録・Cの解析LambdaやStreams設定の変更は行わない。データが0件でもAPIが正常なら構築を完了し、配送・区画の件数を表示する。Cの解析が結果を書き込むようになると、そのデータを画面から参照できる。一覧・区画は1ページずつ取得し、詳細は配送IDで索引をQueryする。

## 終了時の確認

成功するとWeb URL、API URL、3テーブル名、配送・区画の件数を表示し、`.local/d-deploy/<StackName>/result.json` に記録する。次を自動確認する。

- healthのstatus=ok、deployment=aws、dataMode=dynamodb。
- S3画面のOriginに対応したCORS応答。
- S3のindex.htmlとapp.jsのContent-Type、公開config.jsのAPI URL。
- 配送一覧・路面区画一覧APIの応答形式。

最後に表示されたWeb URLをブラウザで開き、配送選択・グラフ・地図を確認する。自動確認はHTTP/APIの確認であり、全ブラウザの操作や実機計測までを検証するものではない。

## 更新・チーム統合

同じモード・StackNameで同じコマンドを再実行すれば、Dのコード・画面・構成を更新できる。画面は画像等、JS、CSS、index.htmlの順にアップロードし、JS/CSSのContent-Typeを明示する。既存のS3オブジェクトは削除しない。

同じスタックの `TableMode` は切り替えない。仮環境とチーム環境は別のStackNameを使う。手動で作った既存のD環境を自動的に取り込む処理ではなく、新しい管理用スタックを作成する。現在公開済みの手動構築サイトは、新しい構築先URLへ切り替えるまでそのまま使える。

全体の構築用スクリプトから、このスクリプトを必要な引数付きで呼び出せる。成功時の戻り値はDashboardUrl / ApiBaseUrl / 3テーブル名などのオブジェクト。例：

```powershell
$dResult = .\scripts\deploy-dashboard.ps1 -TableMode prototype
$dResult.DashboardUrl
```

`-ExpectedAccountId <12桁のアカウントID>` を付けると、別のアカウントならAWSへの書き込み前に停止する。Node.jsがPATHにない場合は `-NodePath 'C:\Program Files\nodejs\node.exe'` を指定できる。`-Region` と `-MaxPageItems`（1〜1000、1回の取得件数）も指定可能。

## 失敗時・削除時

失敗時は完了扱いにせず例外を返す。認証情報の期限、テーブル名、LabRoleの読み取り・ログ権限、CloudFormationのイベントを確認する。S3バケットポリシーがBlockPublicPolicyで拒否される場合はアカウント側の公開制限を確認する。スクリプトはアカウント全体の設定を変更しない。

初回失敗のROLLBACK_COMPLETEなどは自動で削除せず停止する。CloudFormationで失敗理由と残存リソースを確認し、必要な処置を行ってから再実行する。storageだけ作成されてbackendが失敗した場合も、成功扱いにしない。

S3の2バケットと仮テーブル3つはRetainを指定している。スタック削除時もデータは残り、バケットポリシー等は削除される。不要になったデータは保管が必要か確認した後、手動で削除する。保持リソースはスタック再作成時に自動で取り込まれない。Lambdaコードの古いZIPも自動削除しない。

## この追加の検証範囲

AWS CLIとHTTPSをモックした12シナリオで、2モード、再実行でのサンプル維持、空テーブル、アカウント違い、モード切替拒否、CloudFormation/CORS失敗時の停止を確認。実際のAWSアカウントへの新規デプロイは未実施。実行時に `cloudformation validate-template` と公開URL確認を行う。

```powershell
.\scripts\tests\dashboard-deploy.test.ps1 -NodePath 'C:\Program Files\nodejs\node.exe'
```

参照：[CloudFormation deployとパラメータJSON](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/deploy.html)、[Lambdaのコードとロール指定](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-function.html)、[HTTP API](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-apigatewayv2-api.html)、[HTTP API Stage](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-apigatewayv2-stage.html)。

## 取得方式の更新と既存環境への反映

既存の解析結果テーブルにはDeliveryTimeIndexが必要です。構築時に索引のキー・Projectionを確認し、CREATING/UPDATINGなら約10分までACTIVEを待ちます。[Cの索引追加とD更新の手順](d-query-index-upgrade.md)を参照してください。
