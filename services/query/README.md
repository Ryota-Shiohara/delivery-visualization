# 参照Lambda（担当D）

配送一覧・詳細・時系列・走行軌跡・注意地点・路面評価をWebへ返します。

- APIの入出力は `contracts/` で合意する。
- 閲覧権限、取得期間、地図範囲、ページング、件数上限を設計する。
- 配送スコアや地図は解析結果から、時系列・軌跡は必要に応じて計測データから取得する。
- 一覧・詳細・地図の取得要件を担当Bへ共有し、キーとインデックスを設計する。

`local-contract.mjs`にCの入力検証とローカル参照APIの仮実装を追加しました。API形式は `contracts/d-query-prototype.md` を参照。

`index.mjs`と`aws-handler-core.mjs`はAWS用の仮参照Lambdaです。demo / c-exampleではZIP内のサンプル、dynamodbでは指定した3テーブルの小規模Scanを使います。Dの個人アカウントではS3 / HTTP API / Lambda / DynamoDBの共有例に接続し仮動作を確認済みです。[確認記録](../../docs/reports/d-aws-verification.md)を参照してください。最終統合用のキー・Query設計はB/Cとの合意後に実装します。`scripts/package-d-aws.ps1`で`.local/artifacts/` にアップロード用ZIPを準備できます。サンプルJSONはパッケージ作成時にLambdaコードの直下へコピーされます。
