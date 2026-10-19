# 参照API（担当D）

AWSでは配送一覧をsummaryだけから取得し、配送詳細はDeliveryTimeIndexをQueryして指定した配送だけを読む。路面はcellだけを読む。全テーブルScan・累計5000件の上限・30秒キャッシュは使用しない。

各APIはlimit（1〜1000）とcursorを受け取り、nextTokenを返す。ローカルも同じページング形式。詳細はCのsummaryをGetItemし、avgScoreを再計算しない。healthは設定・プロセスの応答確認であり、DB全件読み出しはしない。

配送詳細では `sampling=uniform&limit=500` により、先頭・末尾の各1件と最大50の時間帯から合計最大500件を返す。各時間帯は時刻索引の範囲条件とLimitを指定して1ページだけ取得し、続きを読まない。最大52回のQuery（時間帯は最大4並列）で、全計測の読み取りを避ける。画面の初回取得・自動更新で使用し、cursorとは併用しない。totalはsummary.sampleCount（なければnull）。空区間などでは500件未満となり、少数件でも全件取得は保証しない。

- index.mjs：Lambda入口、SDK接続とモード選択。
- dynamo-reader.mjs：Scan/GetItem/Queryのルート別取得。
- pagination.mjs：件数・ルートと配送に結び付いた続き情報。
- local-contract.mjs：データ検証・ローカル参照。
- aws-handler-core.mjs：HTTP APIイベント・エラー応答。

環境変数：DATA_MODE、ANALYSIS_TABLE、SUMMARY_TABLE、CELL_TABLE、ANALYSIS_INDEX（標準DeliveryTimeIndex）、MAX_PAGE_ITEMS（標準1000）。LambdaのNode.jsランタイム内SDKを使用する。scripts/package-d-aws.ps1で7ファイルをZIPにまとめる。

[反映手順](../../docs/deployment/d-query-index-upgrade.md)と[API仕様](../../contracts/d-query-prototype.md)を参照。索引不足は503、入力不正は400、DB権限などの失敗は500。索引はACTIVEになってから使う。

## 衝撃地点を全件取得する

軌跡の抽出とは別に `GET /api/deliveries/{deliveryId}?impacts=only&limit=500` を使用します。応答の `measurements` は衝撃のみ、`total` は配送集計の衝撃件数、`nextToken` は衝撃専用の続き情報です。`sampling` との併用と、通常計測のcursorとの混用は400です。

AWSでは `ImpactDeliveryTimeIndex`（`impactDeliveryId` / `measuredAt`、Projection ALL）をQueryし、通常計測の全件Scanは行いません。`IMPACT_INDEX` で索引名を変更できます。画面は衝撃の全ページを取得して重複を除き、選択中・全配送の地図、タイムライン、明細に反映します。軌跡の線は抽出計測のままにし、衝撃の補完点を軌跡に結びません。

座標なしの衝撃は明細・件数に残し、地図に表示できない件数を案内します。衝撃の取得失敗や集計との件数差を表示し、再取得します。衝撃取得に失敗しても抽出軌跡は利用できます。GSIの非同期反映による一時的な差は許容します。
