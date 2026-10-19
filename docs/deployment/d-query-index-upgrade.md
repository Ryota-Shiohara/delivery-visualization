# 配送単位の取得と画面更新を既存環境へ反映する

この変更は、累計5000件で止まる全テーブル読み込みを廃止し、配送一覧はsummary、配送詳細は選択したdeliveryIdのanalysis、路面一覧はcellからそれぞれ1ページずつ取得する。Cの解析アルゴリズムは変更せず、Cのテーブル構成に索引を追加する。

## 更新する内容

- `infra/analysis.yaml`：解析結果テーブルにDeliveryTimeIndexを追加。パーティションキーdeliveryId、ソートキーmeasuredAt、両方文字列、Projection=ALL。
- `infra/dashboard.yaml`：Dの仮解析テーブルにも同じ索引を追加。参照LambdaにANALYSIS_INDEXとMAX_PAGE_ITEMSを設定。
- `services/query/`：一覧・区画は小分けのScan、配送詳細はsummaryのGetItemと索引のQuery。APIはnextTokenを返す。
- `apps/dashboard/`：配送・計測・路面の続きを明示的に読み込む。開発用データ連携タブ・Cへの確認事項・仮環境フッターを削除。配送集計のスコアと各計測時のスコアを区別する。

MAX_PAGE_ITEMSは1回の取得件数の上限（1〜1000、標準1000）。累計件数の上限ではない。画面は配送一覧50件、詳細500件、路面100件を要求し、構成側の上限が小さければその件数まで返す。旧MAX_TABLE_ITEMSは使用しない。テーブル全体を読む30秒キャッシュも廃止する。

## 代表者の既存環境を更新する順序

1. GitHubの変更をマージして、構築用PCのコードを最新にする。
2. AWS AcademyのLabを起動し、`.env`の一時認証情報を更新する。
3. **Cのスタックを先に更新する。** 既存の解析結果テーブルに索引を追加するため、同じAnalysisStackと同じMeasurementsStreamArnを使う。テーブルを削除・再作成する必要はない。
4. 索引がACTIVEになった後、DのLambda・画面・環境変数を更新する。構築スクリプトはCREATING/UPDATINGを約10分まで待ち、索引のキーとProjectionを確認する。索引がない、定義が違う、準備が終わらない場合は停止する。
5. 公開サイトを再読み込みし、必要ならブラウザの強制再読み込みを行う。

すでに `scripts/deploy-all.ps1` で構築している場合は、**同じスタック名・リージョン**で同じスクリプトを再実行すれば、C→Dの順に更新する。前回の記録を使う例：

```powershell
$previous = Get-Content .local/deploy-all/result.json -Raw | ConvertFrom-Json
.\scripts\deploy-all.ps1 `
  -Region $previous.Region `
  -IngestionStack $previous.IngestionStack `
  -AnalysisStack $previous.AnalysisStack `
  -DashboardStack $previous.DashboardStack `
  -CollectorStack $previous.CollectorStack
```

これは標準のS3配信の例。AをCloudFrontで配信している環境では前回と同じCollectorHostingも指定する。

CとDだけを更新する場合は、既存のBスタックからMeasurementsStreamArnを取得し、`scripts/deploy-sam.ps1 -TemplateFile infra/analysis.yaml -StackName <既存Cスタック> -ParameterOverrides @('MeasurementsStreamArn=<既存Stream ARN>')` でCを更新する。その後、`scripts/deploy-dashboard.ps1 -TableMode existing` に既存Cテーブル3つと前回のDのStackName・Regionを指定する。[Dの構築手順](d-dashboard-automated.md)を参照。

Dのみのprototypeモードでは、同じDのStackNameで再実行するとDが管理する仮テーブルへ索引を追加する。既存の手動テーブルをCloudFormationへ自動取り込みする処理ではない。手動作成のテーブルなら、テーブルの管理者が同じ索引を追加してからDを更新する。

## 更新後の確認

1. DynamoDBの解析結果テーブルでDeliveryTimeIndexがACTIVE。
2. Lambdaの環境変数ANALYSIS_INDEX=DeliveryTimeIndex、MAX_PAGE_ITEMS=1000。実際のテーブル名を維持する。
3. `/api/deliveries?limit=50` がsummaryだけを返し、必要ならnextTokenがある。
4. 配送を選択し、最大500件の計測と全配送集計スコアが表示される。「計測の続きを読み込む」で件数が増える。
5. 路面区画の追加読み込み、配送切り替えでグラフ・地図・明細が変わる。
6. 5000件を超える配送でも、続きを読み進められる。

索引は既存項目からも作成されるが、deliveryId/measuredAtが欠落・空文字・型不正の項目は対象外になる。索引への反映は結果テーブルと同時ではないため、書き込み直後に一時的な件数差が出る場合がある。参照LambdaのLabRoleにはテーブルのGetItem/Scanと索引ARNへのQuery権限が必要。不足する場合は管理者・TAへ確認する。

## 表示の範囲

配送一覧の検索・並び順は読み込み済みの配送が対象。計測グラフ・軌跡・衝撃明細は読み込み済みの計測が対象で、その件数を表示する。配送スコアはCのsummary.avgScoreを使い、部分取得した計測から再計算しない。路面の地図は読み込み済みの全区画を、CのavgScoreに応じた半透明のヒートマップで表示する。区画一覧にも平均スコアを表示し、スコア未取得は0点と区別する。

今回の修正は取得方法とUIの整理。**計測停止を通知して配送評価を確定する仕組みは、A/B/Cの終了通知の契約がまだないため追加していない。** 完了した配送だけを示すと偽らず、現在は配送集計として表示する。

## 検証

モックのDynamoDBで6001件を500件ずつ13回で取得し、重複なし・集計スコア維持を確認。ローカルブラウザで計測500→1000件、配送50→60件、路面100→150件を確認。実AWSへのデプロイとGSI構築は未実施。今回のコードを反映するには上記の更新が必要。

参照：[GSIの既存テーブルへの追加](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html)、[Queryのページング](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html)。
