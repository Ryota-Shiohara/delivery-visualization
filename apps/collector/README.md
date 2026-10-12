# Collector：スマホ計測プロトタイプ

React・TypeScript・Viteによるブラウザアプリです。加速度・姿勢・GPSの取得、計測の開始・終了、端末内保存、JSON出力を試せます。PC向けの模擬モードもあります。

## PCで試す

Node.js 20.19以降の20系、または22.12以降が必要です。

```powershell
cd C:\Ryota\university\delivery-visualization\apps\collector
npm ci
npm run dev
```

`http://127.0.0.1:5173` を開きます。「模擬データで試す」→「センサを有効にする」→「この姿勢で校正」→「計測を開始する」→「計測を終了して保存」の順に操作します。「JSON出力」または履歴の「JSON」で記録を取り出せます。模擬モードの値はすべて架空です。

## スマホ実機で試す：ローカルHTTPS

PCとスマホを同じWi-Fiに接続します。PCのLANアドレスでHTTPS接続し、両端末で開発証明書を信頼させる必要があります。スマホ側のlocalhostはPCを指しません。

次は[mkcert公式手順](https://github.com/FiloSottile/mkcert)に基づく例です。mkcertのインストールと信頼設定は各端末で行います。このリポジトリは証明書を自動インストールしません。

```powershell
# apps/collector内で実行。IPアドレスはPCの実際のWi-Fi IPv4に置き換える。
mkcert -install
New-Item -ItemType Directory -Force .certs
mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost 127.0.0.1 ::1 192.168.1.100
mkcert -CAROOT
npm run dev:https
```

`mkcert -CAROOT` が示すフォルダの `rootCA.pem` をスマホに入れて信頼設定します。iPhoneではプロファイルのインストールに加え「証明書信頼設定」で完全な信頼を有効にします。Androidは端末の証明書設定からCA証明書を入れ、ブラウザで警告なく接続できることを確認します。CA秘密鍵 `rootCA-key.pem` はスマホや他人に渡しません。

スマホで `https://192.168.1.100:5173` を開き、実機モードの「センサを有効にする」をタップし、モーションを許可します。位置情報は「GPSを有効にする・再試行」で別途許可します。緯度・経度が表示されてから計測を開始してください。許可画面が出ない場合、既に許可または拒否されている可能性があります。ブラウザのサイト設定と端末の位置情報設定を確認してください。接続できない場合はPCのファイアウォールやWi-Fiの端末間通信制限を確認します。証明書はGit対象外です。

## 計測と保存

- 加速度イベントを最大50Hzで記録、画面は5Hzで更新する。20〜50Hzは実機で検証する目標。画面の受信頻度は直近1秒の有効な加速度イベント数。
- 加速度は重力込みを優先して保存し、`includesGravity` に方式を残す。グラフは取得できれば重力除去済み加速度の大きさ。
- 校正時と現在の重力方向の角度を傾斜とする。未校正・姿勢未取得時はnull。再校正は計測前に行う。
- 実機GPSは「GPSを有効にする・再試行」から要求する。拒否・取得失敗・タイムアウトを区別して表示する。模擬モードでは位置情報の許可を求めない。
- 5秒より古いGPSはnull。位置の更新頻度はブラウザ任せで、1秒間隔を保証しない。
- IndexedDBに各サンプルを順次保存し、保存完了後、30件または最初の蓄積から1秒を目安にまとめてAPIにPOSTする。保存中に届いた分は次の保存処理で扱い、終了時に残りを保存する。匿名端末IDはlocalStorageに保存する。
- 非表示になると計測を終了する。画面消灯中・他タブでの継続計測は対象外。点灯維持の失敗・解除を表示する。
- 1回30,000件で自動終了。ブラウザの強制終了では最後の未保存分が失われる可能性がある。途中保存の記録は「終了未確認」と表示する。
- 保存失敗時はメモリからJSON出力・保存再試行が可能。未保存データがある間は新しい計測を開始しない。
- 履歴は直近10件を表示。ブラウザのデータ削除で記録も消えるため、必要な記録をJSONで保管する。

JSONは `{ exportVersion, session, measurements }` 形式。`session.mode` で模擬／実機を識別し、各計測は共通Schemaに従います。AWSのバッチAPI契約とは別のローカル出力形式です。

## 検証とビルド

```powershell
npm test
npm run build
npm run preview
```

欠測値、傾斜の角度、GPSの鮮度、共通Schema、重複保存、権限要求の順序をテストします。センサ精度・権限・取得頻度・電池消費は別途スマホで確認してください。

`dist/` はS3またはS3＋CloudFrontで配信する静的ファイルです。配信手順は [infra/README.md](../../infra/README.md) を参照してください。

## 担当BのAPIへPOSTする

計測前に「APIへ送信」に担当Bから受け取った完全なHTTPS URL（例：`https://<API ID>.execute-api.us-east-1.amazonaws.com/dev/measurements`）を入力します。「計測を開始する」で各サンプルの自動送信を開始します。未送信分は計測終了後、記録を選んで「選択した記録を送信」で再送できます。URLはブラウザに保存します。API URLは `delivery-visualization-b` スタックの `MeasurementApiUrl` 出力から確認できます。

現在の初期URLは `https://0cori0yr7d.execute-api.us-east-1.amazonaws.com/dev/measurements` です。以前に送信先を保存したブラウザでは保存済みURLを優先します。画面でURLを確認・変更してから送信してください。

collectorは最大30件を `{ "measurements": [...] }` にまとめてPOSTします（JSON出力ファイル全体は送りません）。各 `Measurement` に追加の `mode: 'device' | 'demo'` で実機と模擬を識別します。AWS認証情報はブラウザへ渡しません。認証付きAPIに変更する場合は別途認証方式への対応が必要です。

送信中は件数・進捗を表示し、中止できます。HTTPエラー・通信エラー・15秒のタイムアウト・APIの保存確認不一致があれば停止します。APIの `{ savedMeasurementIds: [...], failedMeasurementIds: [...] }` 応答を検証し、成功IDだけをIndexedDBに保存するため、同じAPI URLへの再送では確認済みの分を省略します。応答を受け取れなかった場合は再送しますが、担当BのDynamoDBでは同じIDを上書きします。送信後も端末内の記録は残ります。URLを変えると別の送信先として扱います。

30件蓄積・最初の蓄積から1秒経過・計測終了のいずれかで送信します。1リクエストは最大30件で、自動送信は最大5リクエストを並行処理します。手動再送も30件ずつです（手動再送は順次処理）。送信待ち件数には30件への蓄積中とAPIの保存確認待ちも含むため、単件送信との比率だけでは通信遅延を判断できません。通信が追いつかない分は待機するため、到着までの遅延は保証しません。計測終了後も待機分を送信し、完了までは手動再送・次の自動送信を開始しません。通信エラー時は後続の自動送信を停止し、端末内の記録から手動再送できます。30件ずつまとめると30,000件で約1,000回のリクエストです。時間経過や終了時の端数送信・再送がある場合は増えます。模擬モードもAPIへ送信します。画面を閉じると送信は中止され、保存確認済みの分から再送できます。

### 一括送信に必要な担当B側のAPI対応

この変更はcollectorのみです。既存の単件APIは、この本文と応答形式に対応するまで使用できません（自動で単件に切り替えません）。担当B側で以下の契約を反映してください。

- リクエスト：`{ "measurements": [Measurement + mode, ...] }`（1〜30件）。
- HTTP 200応答：`{ "savedMeasurementIds": [保存済みID, ...], "failedMeasurementIds": [保存失敗ID, ...] }`。
- リクエストの各IDを成功・失敗のどちらかに必ず1回含める。未知ID・重複ID・欠落IDの応答はcollectorで確認不一致として停止する。
- 部分成功時は成功IDのみを送信済みにし、失敗分は計測終了後の手動再送で再試行する。
- 入力不正（空配列・30件超過・必須項目欠落・ID重複）はHTTP 400。再送では同じmeasurementIdを使用する。

### ブラウザから送信するための担当B側の変更

`infra/template.yaml` にOPTIONSのCORS応答、`services/ingestion/lambda_B.py` にPOST応答のCORSヘッダーを追加しています。ブラウザからは両方が必要です。担当BのAPIへこれらの変更を反映してから確認してください。collectorだけを再配信しても、既存APIのCORS設定は更新されません。

SAMの `CollectorOrigin` パラメーターは既定で `*` です。配信先を限定する場合は `https://<バケット名>.s3.us-east-1.amazonaws.com` を指定します。`/site/index.html` は含めません。CORSは認証の代わりにはなりません。

## ソースの責務

| ファイル | 責務 |
| --- | --- |
| `src/App.tsx`・`styles.css` | 計測画面とモバイルレイアウト |
| `src/sensors.ts` | 権限・実機センサ・模擬センサ |
| `src/measurement.ts` | 計測整形・傾斜・GPS鮮度 |
| `src/storage.ts` | IndexedDB・JSON出力 |
| `src/useCollector.ts` | 計測状態・定期保存・点灯維持 |
| `src/UploadPanel.tsx`・`upload.ts`・`liveUpload.ts` | API送信画面・30件ごとのPOST・進捗・中止 |
