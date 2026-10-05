# フードデリバリー品質管理・路面評価マッピングシステム

スマホで配送中の加速度・傾斜・位置を計測し、AWSに保存・解析して配送品質と路面評価をWebで可視化する、4人チーム用のモノレポです。

元の[システム概要](フードデリバリー品質管理・路面評価マッピングシステム_概要.md)を設計の出発点とします。[collectorのブラウザ版プロトタイプ](apps/collector/README.md)は実装済みです。ダッシュボード、API、解析処理、AWSリソースはまだ実装されていません。

## ディレクトリ構成

```text
delivery-visualization/
├── apps/
│   ├── collector/           # A：スマホ計測・校正・一時保存・再送
│   └── dashboard/           # D：地図・グラフ・配送履歴
├── services/
│   ├── ingestion/           # B：受信Lambda・入力検証・重複判定
│   ├── analysis/            # C：解析Lambda・品質評価・地点集計
│   └── query/               # D：参照Lambda・結果取得
├── contracts/               # 全員：API・JSON Schema・データ項目
│   └── schemas/
├── infra/                   # B中心：AWS構成・権限・保存期間
├── data/
│   └── samples/             # 全員：架空の連携用サンプル
├── docs/
│   ├── architecture.md      # 構成・責務・データフロー
│   ├── development.md       # 開発の順序・完了条件
│   ├── course-requirements.md # 授業資料との照合・年度差
│   ├── presentation/        # 構想説明・共通スライド・デモ手順
│   ├── reports/             # 評価記録・個人レポートの素材
│   └── decisions/           # 技術選定・設計判断の記録
├── tests/                   # 結合検証・システム評価
├── scripts/                 # ローカル開発・検証の補助
├── AGENTS.md
└── README.md
```

各アプリ・サービスの単体テストは、その実装と同じフォルダに置きます。複数の担当をまたぐ検証は `tests/` に置きます。

## 開発を始める順序

1. collectorはReact＋TypeScript＋Viteを採用。[未確定事項](docs/decisions/README.md)を合意し、他のアプリ・Lambdaの言語とAWS構成管理ツールを選ぶ。
2. [共通データ定義](contracts/README.md)とAPI仕様を確定する。現在のSchemaとサンプルはたたき台です。
3. 架空サンプルを使って計測・受信・解析・表示を並行実装する。
4. [開発・検証手順](docs/development.md)に沿って結合し、実機データで評価する。

実測位置情報や認証情報はGitに追加しません。push・デプロイ・worktree作成は禁止します。コミットは `feat: 計測データの受信処理を追加` のように日本語で記述します。

授業資料の条件は[資料との照合記録](docs/course-requirements.md)を参照してください。2025年度の概要資料と2026年10月更新の手引書を区別して記録しています。
