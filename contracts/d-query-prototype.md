# D参照APIとCの解析結果

Cのanalysis / summaries / cellsのフィールド名・データ形式は維持する。開始・終了・完了の状態を推測しない。振動は現在のC解析のm/s²。スコアはCの集計値を表示し、D側で再計算しない。

## 取得

| GET | 内容 |
| --- | --- |
| /api/deliveries | summaryテーブルのみから配送一覧を1ページ取得 |
| /api/deliveries/{deliveryId} | summaryをGetItemし、analysisのDeliveryTimeIndexをQuery |
| /api/cells | cellテーブルのみから区画一覧を1ページ取得 |
| /api/health | 設定とプロセスの応答確認。DBを全件取得しない |

全APIにlimit（1〜1000、標準500）とcursorを指定できる。MAX_PAGE_ITEMSが小さい場合はその件数まで。続きは応答のnextTokenをcursorに入れ、同じAPI・配送で取得する。nextToken=nullなら終端。1MB制限などで要求件数より少ないページになる場合も、続き情報があれば読み進める。offset/nextOffsetは廃止。

一覧は {items:[{deliveryId,summary}],nextToken,meta}、詳細は {deliveryId,summary,measurements,total,nextToken,meta}、区画は {items,scope,nextToken,meta}。AWS詳細のtotalはsummary.sampleCount（なければnull）であり、GSI内の件数を数えるための全件読みにしない。書き込み・索引反映の途中で件数差があり得る。summary未作成でも計測があれば詳細取得可能だが、一覧にはsummaryのある配送だけが出る。

索引：DeliveryTimeIndex / HASH deliveryId（S）/ RANGE measuredAt（S）/ Projection ALL。元テーブルのキーmeasurementIdを保持する。measuredAtはAから来るUTCのISO日時を維持する。GSIは結果テーブルと非同期で反映される。

一覧は1ページずつScan。画面上の並び順・検索は読み込み済みの範囲。全期間を時刻順で検索する索引は今回追加しない。Queryの詳細は時刻昇順で取得し、同時刻の計測は複数存在し得る。

不正な件数/cursorは400、不存在は404、索引が使えない場合は503、DB接続/権限失敗は500。エラー形式は {error:説明}。メタデータに開発用のC確認事項は載せない。

## ローカル操作

PC内のJSON取り込み・サンプル切替・書き出し用APIは維持。これらのPOSTはAWSへ移さない。公開画面は配送モニターと路面区画の2画面とし、開発用データ連携タブを削除する。
