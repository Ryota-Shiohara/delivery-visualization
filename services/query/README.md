# 参照API（担当D）

AWSでは配送一覧をsummaryだけから取得し、配送詳細はDeliveryTimeIndexをQueryして指定した配送だけを読む。路面はcellだけを読む。全テーブルScan・累計5000件の上限・30秒キャッシュは使用しない。

各APIはlimit（1〜1000）とcursorを受け取り、nextTokenを返す。ローカルも同じページング形式。詳細はCのsummaryをGetItemし、avgScoreを再計算しない。healthは設定・プロセスの応答確認であり、DB全件読み出しはしない。

- index.mjs：Lambda入口、SDK接続とモード選択。
- dynamo-reader.mjs：Scan/GetItem/Queryのルート別取得。
- pagination.mjs：件数・ルートと配送に結び付いた続き情報。
- local-contract.mjs：データ検証・ローカル参照。
- aws-handler-core.mjs：HTTP APIイベント・エラー応答。

環境変数：DATA_MODE、ANALYSIS_TABLE、SUMMARY_TABLE、CELL_TABLE、ANALYSIS_INDEX（標準DeliveryTimeIndex）、MAX_PAGE_ITEMS（標準1000）。LambdaのNode.jsランタイム内SDKを使用する。scripts/package-d-aws.ps1で7ファイルをZIPにまとめる。

[反映手順](../../docs/deployment/d-query-index-upgrade.md)と[API仕様](../../contracts/d-query-prototype.md)を参照。索引不足は503、入力不正は400、DB権限などの失敗は500。索引はACTIVEになってから使う。
