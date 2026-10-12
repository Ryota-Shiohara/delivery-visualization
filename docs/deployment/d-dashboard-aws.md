# D担当：AWS上でダッシュボードを表示する手順

作成日：2026年10月12日。対象：AWS Academy、自分のAWSアカウント、us-east-1、CloudFrontなし。

同じ環境をスクリプトで構築する場合は [Dの自動構築手順](d-dashboard-automated.md) を参照してください。以下はコンソールでの手動手順です。

## ローカル表示とAWS表示の違い

`http://127.0.0.1:4173` は、あなたのPC上で動いている画面です。画面のファイルも、データを返すNode.jsサーバーもPC内にあります。127.0.0.1は「このPC自身」を指すので、他の人のPCから同じURLを開くことはできません。

AWSへ移すと、以下になります。

```text
S3 ── HTML・CSS・JavaScriptをHTTPSで配信 ──→ ブラウザ
                                                  │
                                      API Gateway（HTTP API）
                                                  │
                                             参照Lambda
                                                  │
                         最初：ZIP内の架空サンプルJSON
                         次：DynamoDBのC解析結果3種類
```

ブラウザそのものはPCやスマホで動き続けます。AWSに置くのは画面ファイルとデータを返す処理です。

最初は**サンプルJSONを返すLambdaで、AWS上の画面表示を完成**させます。その後、Lambdaの設定を変えてDynamoDBの読み出しへ進みます。サンプル表示段階では、Cの解析処理・テーブル完成を待つ必要はありません。

## アップロード用ファイルを作る

リポジトリ直下で `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-d-aws.ps1` を実行します。Node.js 20以上が必要です。ZIPと設定テンプレートは `.local/artifacts/` に出力され、Git対象外になります。この操作でAWSリソースは作成しません。設定例の原本は `infra/examples/d-dashboard/` にもあります。

## 作成されるファイル

- `D担当_AWS参照Lambda.zip`：Lambdaへ、そのままアップロードします。解凍しません。
- `D担当_S3画面.zip`：PCで解凍し、中の`dashboard`フォルダをS3へアップロードします。
- `D担当_AWS設定テンプレート/s3-public-read-policy.json`：S3バケットの公開読み取り設定。
- `D担当_AWS設定テンプレート/test-deliveries.json`：Lambdaのテスト入力。
- `D担当_AWS設定テンプレート/dynamodb-items/`：DynamoDBの項目作成画面へ貼るC共有例。

最初にメモする情報：①S3バケット名、②APIのURL、③S3画面のURL。この3つを混同しないようにします。

## 1．AWS Academyに入る

1. AWS AcademyのCanvasへ、自分の受講生アカウントでログインします。
2. Learner Labを開き、**Start Lab**を押します。
3. AWSの表示が緑になってから、**AWS**を押してAWSコンソールへ進みます。
4. AWSコンソール右上のリージョンを、**米国東部（バージニア北部）us-east-1**にします。

この後のS3・Lambda・API Gateway・DynamoDBは、すべてこのリージョンにそろえます。個人の課金用アカウントと混同せず、今回の自分のAcademyアカウントを使います。

## 2．S3の保存先を作る

1. コンソールの検索欄で **S3** を検索して開きます。
2. **バケットを作成**を押します。
3. バケットの種類は**汎用**、リージョンは**us-east-1**にします。
4. バケット名を入力します。例：`delivery-d-yourname-20261012-abc123`。
   - `yourname`と末尾を自分用に変更します。
   - 世界中で重複しない名前が必要です。
   - 小文字・数字・ハイフンを使い、今回はドットを使わない名前にします。
5. オブジェクト所有者は**ACL無効／バケット所有者の強制**のままにします。
6. その他もまず既定値のまま、バケットを作成します。

このバケットは画面専用にします。`state.json`、認証情報、取り込んだ実測データ、リポジトリ全体はアップロードしません。画面ファイルだけを入れます。

この時点ではまだ非公開なので、ブラウザでURLを開いても表示できません。公開設定は手順7で行います。**静的ウェブサイトホスティングは有効にしません。** 通常のS3オブジェクトURLを使います。

## 3．参照Lambdaを作る

1. コンソールで **Lambda** を開きます。
2. **関数の作成** → **一から作成**を選びます。
3. 次の設定にします。

| 項目 | 値 |
| --- | --- |
| 関数名 | `delivery-d-query` |
| ランタイム | Node.js 22.x（24.xでも対応） |
| アーキテクチャ | x86_64（既定値） |
| 実行ロール | デフォルトの実行ロールの変更 → 既存のロールを使用する → `LabRole` |

4. **関数の作成**を押します。新しいIAMロールは作成しません。
5. 関数の**コード**タブで、**アップロード元** → **.zipファイル**を選びます。
6. `D担当_AWS参照Lambda.zip`を選び、保存します。
7. **ランタイム設定**でハンドラーが **`index.handler`**になっていることを確認します。
8. **設定** → **一般設定** → **編集**で、タイムアウトを**10秒**、メモリを**128MB**にして保存します。VPCやレイヤーは追加しません。
9. **設定** → **環境変数** → **編集**で、以下を追加します。

| キー | 値 |
| --- | --- |
| `DATA_MODE` | `demo` |

`demo`は架空の3配送を表示する設定です。Cの添付例をそのまま表示したい場合は`c-example`にします。値の変更後は保存してください。

### Lambdaだけで動作確認

1. **テスト**タブを開き、新しいテストイベントを作成します。
2. 名前を`test-deliveries`などにして、次を入力します。

```json
{
  "version": "2.0",
  "rawPath": "/api/deliveries",
  "rawQueryString": "",
  "requestContext": {
    "http": { "method": "GET" }
  }
}
```

3. 保存して**テスト**を押します。
4. 実行結果の`statusCode`が**200**、`body`内に`demo-delivery-001`などの配送があることを確認します。

実行成功の表示だけで判断せず、statusCodeも確認します。500ならログを確認してください。`Cannot find module`ならZIPのアップロード先やファイル構成、`Handler not found`なら`index.handler`を確認します。

## 4．API Gatewayを作る

1. コンソールで **API Gateway** を開き、**APIを作成**を押します。
2. **HTTP API**の**構築**を選びます。今回はREST APIではなくHTTP APIです。
3. 統合の種類として**Lambda**を選び、リージョンus-east-1、関数`delivery-d-query`を指定します。
4. API名を **`delivery-d-api`** にします。
5. ルート設定画面で、次の4つを作ります。作成後にルートを追加しても構いません。

| メソッド | パス | 統合先 |
| --- | --- | --- |
| GET | `/api/health` | delivery-d-query |
| GET | `/api/deliveries` | delivery-d-query |
| GET | `/api/deliveries/{deliveryId}` | delivery-d-query |
| GET | `/api/cells` | delivery-d-query |

6. ステージは **`$default`**、**自動デプロイ有効**で作成します。
7. 各ルートの統合先が同じLambdaになっていることを確認します。
8. サンプル表示用なので認証は設定しません。架空データだけを扱う段階の設定です。実測位置情報を使う前に、チームで認証・閲覧範囲を決めます。
9. ステージやAPIの詳細画面に表示される**呼び出しURL**をコピーします。

URLの例：

```text
https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com
https://9zzzmshng5.execute-api.us-east-1.amazonaws.com
```

この手順では`$default`ステージなので、URLの後ろに`/dev`や`/api`を自分で足しません。画面の設定には、上のベースURLだけを書きます。

### APIをブラウザで確認

ブラウザのアドレス欄で、実際のURLに次を足して開きます。

```text
https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/api/health
https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/api/deliveries
https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/api/cells
```

healthで`status: "ok"`、deliveriesで配送一覧、cellsで区画一覧がJSONとして見えれば成功です。ここではまだダッシュボードの見た目は出ません。

`Not Found`ならルートとメソッド、500/502ならLambda・統合先・呼び出し権限を確認します。HTTP APIの作成自体が権限で拒否される場合は、表示されたエラーをTAへ確認します。新しいロールを勝手に作る手順に切り替えないでください。

## 5．API GatewayのCORSを設定する

S3の画面とAPIは別のドメインになるので、ブラウザからの呼び出しを許可します。

1. 作成したHTTP APIを開き、メニューの **CORS** → **設定／編集**へ進みます。
2. **Access-Control-Allow-Origin**に、自分のS3バケットのオリジンを追加します。

```text
https://delivery-d-999-20261012.s3.us-east-1.amazonaws.com
```

3. 手元の画面からも同じAPIを試す場合は、追加で次を許可します。

```text
http://127.0.0.1:4173
```

4. **Access-Control-Allow-Methods**：`GET`を指定します。
5. **Access-Control-Allow-Headers**：今回のGETは追加ヘッダーなしで動きます。指定欄が必要なら`content-type`を指定します。
6. **Access-Control-Allow-Credentials**：無効にします。
7. 保存します。自動デプロイが無効になっていた場合はデプロイします。

オリジンには **`/dashboard/index.html`などのパスや末尾のスラッシュを入れません。** ドメイン部分までです。HTTP APIはCORSの設定に基づいて必要な応答を付けるため、Lambda側にCORSコードを追加する必要はありません。

APIのURLを直接開けても、ダッシュボードから呼べない場合は、まずこの設定を確認します。

## 6．画面ファイルの接続先を変更してS3へ入れる

1. PCで`D担当_S3画面.zip`を右クリックして、**すべて展開**します。
2. 中の`dashboard`フォルダを開きます。次のファイルがあります。

```text
dashboard/
├── index.html
├── styles.css
├── app.js
├── config.js
└── vendor/
    └── leaflet/
        ├── leaflet.js
        ├── leaflet.css
        ├── LICENSE
        └── images/
```

3. `config.js`をメモ帳などで開きます。
4. `YOUR_API_ID`を含む仮URLを、手順4でコピーした自分のAPI URLに置き換えます。

```javascript
window.DASHBOARD_CONFIG = {
  apiBaseUrl: "https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com",
  deployment: "aws"
};
```

5. 上書き保存します。AWSアクセスキーやパスワードはこのファイルに入れません。
6. S3で自分の画面用バケットを開き、**アップロード**を押します。
7. **フォルダを追加**で、展開した **`dashboard`フォルダそのもの**を選びます。
8. アップロード予定の名前が`dashboard/index.html`、`dashboard/config.js`、`dashboard/vendor/leaflet/leaflet.js`などになっていることを確認します。
9. アップロードします。

ZIPファイルをそのままS3へアップロードしても、Web画面にはなりません。解凍したファイルとフォルダ構造をアップロードします。

## 7．画面用ファイルを公開読み取りにする

今回はCloudFrontを使わず、S3の`dashboard/`以下の画面ファイルを直接読み取れる設定にします。

1. S3バケットの **アクセス許可**タブを開きます。
2. **パブリックアクセスをブロック（バケット設定）** → **編集**を押します。
3. 「すべてのパブリックアクセスをブロック」の一括チェックを外した後、個別設定を次のようにします。

| 設定 | 今回 |
| --- | --- |
| 新しいパブリックACLで付与されたアクセスをブロック | 有効のまま |
| すべてのパブリックACLで付与されたアクセスをブロック | 有効のまま |
| 新しいパブリックバケットポリシーで付与されたアクセスをブロック | 無効 |
| パブリックポリシーを持つバケットへのアクセスをブロック | 無効 |

4. 保存し、コンソールの確認欄が表示されたら内容を確認して入力します。
5. 同じタブの **バケットポリシー** → **編集**を開きます。
6. 次のJSONを貼り、`YOUR_BUCKET_NAME`を自分のバケット名に置き換えます。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadOnlyDashboardFiles",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/dashboard/*"
    }
  ]
}
```

7. 保存します。これは`dashboard/`の読み取りだけを許可します。書き込みやバケット内の一覧取得は許可しません。

アカウント全体のパブリックアクセスブロックが有効だと、バケット設定だけでは公開できません。Academyで変更権限がない場合は、ここでの公開可否をTAに確認してください。あなたのアカウントの権限は、こちらではまだ確認できていません。

## 8．Content-Typeを確認する

1. バケットの **オブジェクト**から`dashboard/index.html`を開きます。
2. **プロパティ**の**メタデータ**で`Content-Type`を確認します。
3. `text/html`になっていればそのままで大丈夫です。違う場合はメタデータの編集で変更します。
4. 他のファイルも、必要に応じて確認します。

| 拡張子 | Content-Type |
| --- | --- |
| .html | text/html |
| .js | text/javascript または application/javascript |
| .css | text/css |
| .png | image/png |

今回は`app.js`がJavaScriptモジュールなので、JSのContent-Typeが特に重要です。`application/octet-stream`ではブラウザが実行を拒否することがあります。`Content-Disposition: attachment`が付いている場合も外します。

## 9．AWSの画面を開く

`dashboard/index.html`の**オブジェクトURL**をコピーしてブラウザで開きます。

```text
https://自分のバケット名.s3.us-east-1.amazonaws.com/dashboard/index.html
```

このURLが、他のPC・スマホでも開ける画面のURLです。HTTPSの通常のオブジェクトURLを使います。S3のHTTP静的Webサイトエンドポイントは使いません。

確認すること：

1. 左側の表示が **AWS PROTOTYPE** になっている。
2. **AWS参照APIに接続** と表示される（狭い画面ではこの文字が省略されます）。
3. 架空の配送一覧とスコア・軌跡・グラフが出る。
4. 配送を切り替えると表示内容が変わる。
5. 「路面区画」へ移動すると集計一覧が出る。
6. PCのローカルサーバーを終了した後でも、AWSのURLで表示できる。

AWS版ではローカルJSON取り込み・データ消去・デモ切り替えを非表示にしています。Cの共有例へ変更する場合はLambdaの`DATA_MODE`を`c-example`にし、画面を更新します。

ここまでで **S3＋API Gateway＋LambdaによるAWS上の仮動作確認が完了**です。まだDynamoDBを使っていなくても、PCのサーバーに依存しない表示になります。

## 10．DynamoDBの仮テーブルで確認する（次の段階）

C/Bがまだテーブルを完成していない場合だけ、Dのアカウントに自分の確認用テーブルを作れます。既存のチーム用テーブルを勝手に作り直しません。

1. **DynamoDB** → **テーブル** → **テーブルの作成**を開きます。
2. 次の3つを作ります。ソートキーは今回は付けません。

| 確認用テーブル名 | パーティションキー | 型 |
| --- | --- | --- |
| d-prototype-analysis | measurementId | 文字列 |
| d-prototype-summary | deliveryId | 文字列 |
| d-prototype-cell | cellId | 文字列 |

3. テーブル設定で**カスタマイズ**を選び、読み書きのキャパシティを**オンデマンド**にします。固定のプロビジョンド容量や追加インデックスは不要です。
4. 各テーブルが**アクティブ**になったら、1つずつ**テーブル項目を探索** → **項目を作成**へ進みます。analysisのJSONはd-prototype-analysis、summaryのJSONはd-prototype-summary、cellのJSONはd-prototype-cellへ入れます。
5. 項目の編集を**JSONビュー**にし、DynamoDB JSON形式で以下のファイルの内容を貼ります。
   - analysis：`dynamodb-items/analysis.json`
   - summary：`dynamodb-items/summary.json`
   - cell：`dynamodb-items/cell.json`
6. 各テーブルに1件ずつ保存します。ファイル全体は1件のオブジェクトであり、配列ではありません。
7. Lambdaの環境変数を次に変更します。

| キー | 値 |
| --- | --- |
| DATA_MODE | dynamodb |
| ANALYSIS_TABLE | d-prototype-analysis |
| SUMMARY_TABLE | d-prototype-summary |
| CELL_TABLE | d-prototype-cell |
| MAX_TABLE_ITEMS | 5000 |

8. Lambdaのテストを再実行し、statusCode 200を確認します。
9. APIの`/api/deliveries`を開き、`sample-delivery-001`と平均スコア92.5を確認します。
10. AWS画面を更新します。**DynamoDB**と表示され、集計100件・受領計測1件の説明が出れば接続できています。

このZIPの仮実装は、小規模確認のためのScanを使い、1MBごとのページを取得します。**各テーブル最大5000件／100ページ**までで、上限を超えたらエラーにします。最大30秒キャッシュするので、項目変更がすぐ見えなければ30秒後に更新します。Scanは読み取り料金が発生するため、最終統合ではB/Cとキー・インデックスを合意してQuery中心に改めます。

Node.jsのLambdaランタイム内のAWS SDKを使う仮実装です。最終統合でSDKのバージョンを固定する場合は依存パッケージをZIPへ含めます。

`AccessDeniedException`ならLabRoleのDynamoDB読み取り権限、`ResourceNotFoundException`ならテーブル名・リージョンを確認します。必要な権限がない場合は手引書に従ってTAへ確認してください。

## 11．Cの実際のテーブルへ接続する

最終的には、Cから以下を受け取ります。

- 3つの実テーブル名と、作成したAWSアカウント・リージョン。
- パーティションキー・ソートキー・インデックス。
- 各項目のJSON例、null表現、振動単位、evalStatusの全値。

同じアカウント・リージョンにテーブルがある場合、仮実装の環境変数をそのテーブル名に変えられます。ただしデータ量と形式が今回の仮実装の制限に収まることが条件です。

**Cのアカウントにあるテーブルを、自分のアカウントからテーブル名だけで読むことはできません。** 授業の最終統合では代表者のアカウントへ各担当の成果物を持ち寄ります。パスワードを共有する必要はありません。B/CのテーブルとDの参照Lambdaを同じ環境へ配置し、API URLとCORS、画面のconfig.jsを更新します。

## よくある症状

| 症状 | 確認する場所 |
| --- | --- |
| S3のURLでAccessDenied | dashboard/以下のポリシー、バケットとアカウントのパブリックブロック、URLのキー |
| 403がバケットのルートURLでだけ出る | /dashboard/index.htmlまで指定する。バケット一覧の公開は不要 |
| HTMLがダウンロードされる | index.htmlのContent-TypeとContent-Disposition |
| 見た目だけ出て数値が空 | config.jsのAPI URL、CORS、APIのJSON応答 |
| Module scriptのMIMEエラー | app.js / config.js / leaflet.jsのContent-Typeとパス |
| 地図部分が空白 | vendor/leafletのフォルダ構造・JS/CSSの読み込み |
| APIでNot Found | GETルートが/api/...になっているか、$defaultステージか |
| APIで500/502 | Lambdaのテスト・CloudWatchログ、統合先・呼び出し権限 |
| 編集したconfig.jsが反映されない | S3へ上書きアップロードしてブラウザを再読み込み。必要ならCtrl+F5 |
| DynamoDBの変更がすぐ表示されない | 仮実装の最大30秒キャッシュを待つ |
| SDKを読み込めない | Node.jsランタイムか確認。必要ならSDKを含むZIPへ変更 |

## 実験終了時

作業が終わったら手引書に沿ってサインアウトし、End Labを実施します。End Labを「作ったリソースが全部削除される操作」とは扱わず、クレジット表示と残存リソースを確認します。自分のアカウント内の仮環境を最終統合後も残すかはチームで決めます。

## 準備済み／未確認

- 準備済み：S3へ上げる画面、Lambda ZIP、サンプル、設定テンプレート、手順書。
- PCで検証済み：参照Lambdaの入力・応答、Scanページ処理・上限、C形式からの変換。
- 未実施：あなたのAWSへのアップロード、リソース作成、実際のAcademy権限、AWS上での表示確認。

## AWS公式資料

- [S3の通常エンドポイントとWebサイトエンドポイントの違い](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteEndpoints.html)
- [S3のパブリックアクセスブロック](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
- [HTTP APIのLambda統合](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)
- [HTTP APIのCORS設定](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html)
- [LambdaのNode.jsハンドラーと実行環境内SDK](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html)
- [DynamoDBのScanとページング](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html)

## 公開設定でエラーが出た場合

`access-analyzer:ValidatePolicy` の権限エラーはポリシー検証用の権限不足です。保存が成功するかは別に確認します。保存時のAPIレスポンスが「public policies are prevented by the BlockPublicPolicy setting」なら、アカウント設定とバケット設定の両方を確認してください。

画面専用バケットで公開バケットポリシーを使う場合、4つの個別設定のうちACLに関する上2つはオンのまま、バケットポリシーに関する下2つはオフにします。全体チェックはオフになります。実際に利用できる設定はLabの管理設定にも依存し、アカウント側で禁止されている場合は管理者に確認します。公開の許可は `dashboard/*` の `s3:GetObject` に限定します。

## 確認済みの仮環境

この手順による担当Dの実施結果と、Cの作業として残る事項は [AWS仮環境の確認記録](../reports/d-aws-verification.md) にまとめています。
