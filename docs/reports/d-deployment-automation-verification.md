# D担当の構築自動化：検証記録

2026年10月12日。Windows PowerShell 5.1 / Node.js 24.21.0。

## 検証したこと

`scripts/tests/dashboard-deploy.test.ps1` はAWS CLIとHTTPSをモックし、実際のAWS通信・リソース作成を行わず11シナリオを検証した。

1. WhatIfではAWS通信・ローカル生成を行わない。
2. existingでテーブル名が不足するとAWS通信前に拒否する。
3. prototypeで既存テーブル名を指定すると拒否する。
4. ExpectedAccountIdと違うアカウントなら書き込み前に停止する。
5. 同じスタックのTableMode変更を拒否する。
6. prototypeで2スタックを構築し、条件付きでサンプル3件を登録。API URLの設定、JS/CSSのContent-Type、HTMLを最後に転送する順序と戻り値を確認する。
7. existingで既存テーブル3つを確認し、データを登録・変更しない。
8. 再実行時に既存のサンプルIDを上書きしない。
9. SkipSampleDataで空の仮テーブルを使える。
10. CloudFormation失敗後にアップロードを続けない。
11. CORS不一致時は成功記録を作らず失敗する。

結果：11シナリオ成功。既存の `tests/d-query.test.mjs` と `tests/d-aws-query.test.mjs` も15項目成功。構築処理のテストでは実際のパッケージ作成スクリプトを実行し、AWSへの通信だけを置き換えた。

追加確認：PowerShell3ファイルの構文解析に成功。2つのCloudFormation YAMLの構文、Ref/GetAtt/Sub/Ifの参照、テーブル作成の条件、公開プレフィックス、非公開のZIP保存先、HTTP API v2、LabRole参照をローカルで確認した。

## 検証していないこと

今回の新しいスクリプトによる実AWSアカウントへのデプロイ、CloudFormationサービス側のスキーマ検証、実際のLab権限、実測計測からのA〜D全体統合は未実施。ローカルのモック成功だけでAWS構築成功とは扱わない。実行時にはCloudFormationのvalidate-templateと構築後の公開HTTP/API確認を行う。

以前のコンソールによる手動構築は [別の確認記録](d-aws-verification.md) を参照。新しい自動構築は既存の手動リソースを取り込まず、別のスタックとURLを作成する。
