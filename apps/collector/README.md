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

スマホで `https://192.168.1.100:5173` を開き、実機モードの「センサを有効にする」をタップし、モーションと位置情報を許可します。接続できない場合はPCのファイアウォールやWi-Fiの端末間通信制限を確認します。証明書はGit対象外です。

## 計測と保存

- 加速度イベントを最大50Hzで記録、画面は5Hzで更新する。20〜50Hzは実機で検証する目標。画面の受信頻度は直近1秒の有効な加速度イベント数。
- 加速度は重力込みを優先して保存し、`includesGravity` に方式を残す。グラフは取得できれば重力除去済み加速度の大きさ。
- 校正時と現在の重力方向の角度を傾斜とする。未校正・姿勢未取得時はnull。再校正は計測前に行う。
- 5秒より古いGPSはnull。位置の更新頻度はブラウザ任せで、1秒間隔を保証しない。
- IndexedDBに2秒ごとに保存し、終了時に残りを保存する。匿名端末IDはlocalStorageに保存する。
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

`dist/` は将来のS3＋CloudFront配信を想定した静的ファイルです。AWSへの送信・認証・デプロイは未実装です。

## ソースの責務

| ファイル | 責務 |
| --- | --- |
| `src/App.tsx`・`styles.css` | 計測画面とモバイルレイアウト |
| `src/sensors.ts` | 権限・実機センサ・模擬センサ |
| `src/measurement.ts` | 計測整形・傾斜・GPS鮮度 |
| `src/storage.ts` | IndexedDB・JSON出力 |
| `src/useCollector.ts` | 計測状態・定期保存・点灯維持 |
