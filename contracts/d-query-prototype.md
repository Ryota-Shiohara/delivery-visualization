# D参照APIとCの解析結果

Cのanalysis / summaries / cellsのフィールド名・データ形式は維持する。開始・終了・完了の状態を推測しない。振動は現在のC解析のm/s²。スコアはCの集計値を表示し、D側で再計算しない。

## 取得

| GET | 内容 |
| --- | --- |
| /api/deliveries | summaryテーブルのみから配送一覧を1ページ取得 |
| /api/deliveries/{deliveryId} | summaryをGetItemし、analysisのDeliveryTimeIndexをQuery |
| /api/deliveries/{deliveryId}?impacts=only | 衝撃専用GSIをQueryし、衝撃だけをページ取得 |
| /api/cells | cellテーブルのみから区画一覧を1ページ取得 |
| /api/health | 設定とプロセスの応答確認。DBを全件取得しない |

全APIにlimit（1〜1000、標準500）とcursorを指定できる。MAX_PAGE_ITEMSが小さい場合はその件数まで。続きは応答のnextTokenをcursorに入れ、同じAPI・配送で取得する。nextToken=nullなら終端。1MB制限などで要求件数より少ないページになる場合も、続き情報があれば読み進める。offset/nextOffsetは廃止。

配送詳細に `sampling=uniform` を指定すると、時刻索引の昇順・降順Query（各Limit=1）で先頭・末尾を取得する。残りの取得枠を最大50の重ならない時間帯に均等配分し、各時間帯の先頭から1ページだけ取得する。通常は両端の時刻を除くミリ秒単位の期間を分割する。同一時刻または1ミリ秒差なら両端を含む期間を分割し、取得後にmeasurementIdで重複を除く。各Queryは時刻のBETWEEN条件とLimitで読み取りを制限し、LastEvaluatedKeyは追わない。最大52回のQuery、時間帯のQueryは最大4並列。DBから受け取る計測数・応答件数はともに最大500件で、全計測の読み取りは不要。

`limit` が500未満ならその件数まで、1なら先頭1件、2なら両端のみ。時間帯の数は残り枠と期間のミリ秒数を上限とする。MAX_PAGE_ITEMSは各時間帯のQuery件数の上限にも適用する。空区間・取得枠未満の区間の余りは他区間で補充しないため500件未満の場合がある。時間に対する配分であり、計測件数に対する一定割合や少数件の全件取得を保証しない。衝撃・ピークが取得されない場合がある。cursorとの併用や他のAPIへの指定は400。応答に `sampling: "uniform"` を追加し、`total` はsummary.sampleCount（なければnull）、`nextToken` はnullとなる。summaryは再計算しない。画面の初回取得・自動更新はこの方式を使う。ローカルではメモリ上のJSONに同じ時間帯の配分を適用する。GSIは非同期反映であり、各Query間のスナップショット整合性は保証しない。

一覧は {items:[{deliveryId,summary}],nextToken,meta}、詳細は {deliveryId,summary,measurements,total,nextToken,meta}、区画は {items,scope,nextToken,meta}。通常のページ取得ではAWS詳細のtotalはsummary.sampleCount（なければnull）であり、GSI内の件数を数えるための全件読みにしない。書き込み・索引反映の途中で件数差があり得る。summary未作成でも計測があれば詳細取得可能だが、一覧にはsummaryのある配送だけが出る。

索引：DeliveryTimeIndex / HASH deliveryId（S）/ RANGE measuredAt（S）/ Projection ALL。元テーブルのキーmeasurementIdを保持する。measuredAtはAから来るUTCのISO日時を維持する。GSIは結果テーブルと非同期で反映される。

一覧は1ページずつScan。画面上の並び順・検索は読み込み済みの範囲。全期間を時刻順で検索する索引は今回追加しない。Queryの詳細は時刻昇順で取得し、同時刻の計測は複数存在し得る。

不正な件数/cursorは400、不存在は404、索引が使えない場合は503、DB接続/権限失敗は500。エラー形式は {error:説明}。メタデータに開発用のC確認事項は載せない。

## ローカル操作

PC内のJSON取り込み・サンプル切替・書き出し用APIは維持。これらのPOSTはAWSへ移さない。公開画面は配送モニターと路面区画の2画面とし、開発用データ連携タブを削除する。

衝撃専用取得では `ImpactDeliveryTimeIndex`（impactDeliveryId / measuredAt）を使用する。`impacts=only` と `sampling` は併用不可。通常計測のcursorとも混用不可。応答に `impacts: "only"` を追加し、`total` は配送集計のimpactCount（未受領はnull）となる。画面は抽出計測に加えて衝撃の全ページを取得し、座標のある衝撃を全件表示する。座標なし・取得失敗・集計件数との反映差は表示する。
