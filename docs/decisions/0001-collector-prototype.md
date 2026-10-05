# 0001：collectorのブラウザ版プロトタイプ

状態：採用。2026年10月5日。

## 背景と選択

最初はスマホブラウザを開いたまま計測・表示を試す。React・TypeScript・Viteを使い、`apps/collector`を独立したnpmパッケージとして実装する。地図・解析・AWS連携は別担当の実装と接続できるように分ける。

センサはDeviceMotion・DeviceOrientation、位置はGeolocation、保存はIndexedDBを使う。Reactの描画は5Hz、計測の記録は最大50Hzとし、ブラウザから届いた値のみを記録する。GPSの1秒間隔、加速度の20〜50Hzは保証せず実機で確認する。

傾斜は校正時と現在の端末内重力方向の角度とし、方位の回転は含めない。未校正・姿勢未取得・古い姿勢値はnull。位置は5秒を超えて古い場合null。取得した加速度は重力込みを優先して記録し、includesGravityに方式を残す。グラフには取得できればブラウザの重力除去済み加速度を使う。

模擬モードは架空データのみ使用し、セッションのmodeと画面に明示する。JSONはsessionメタデータと、既存共通Schemaに沿ったmeasurements配列を含むローカル出力形式とする。AWSのバッチAPI契約は別途確定する。

## 範囲と制約

- 権限確認、ライブ表示、校正、開始・終了、端末内保存、JSON出力まで実装する。
- 2秒ごとに保存し、保存成功前にメモリの計測を破棄しない。
- 1回30,000件までとし、上限に達したら自動終了する。
- 非表示になったら終了して保存する。バックグラウンドの連続計測は対象外。
- 点灯維持を試み、失敗・解除を表示する。
- スマホ実機には信頼されたローカルHTTPS接続が必要。
- 将来のS3＋CloudFrontの静的配信を想定する。今回の作業ではデプロイしない。

## 参照

- [Device Motion](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent)
- [Device Orientationの仕様](https://www.w3.org/TR/orientation-event/)
- [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
- [Vite](https://vite.dev/guide/)
