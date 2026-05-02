# SHI-001 モノレポ構成と開発基盤を作成する

## 概要

| 項目 | 内容 |
| --- | --- |
| 優先度 | P0 |
| マイルストーン | M1: ローカル最小版 |
| 依存 | なし |

## 目的

将来の macOS / Web / iPhone 展開を妨げないよう、アプリと共通パッケージを分離した開発基盤を作ります。

## 作業内容

- `apps/desktop` を作成する
- `packages/core`、`packages/schema`、`packages/ui`、`packages/editor` の初期ディレクトリを作成する
- TypeScript、lint、format、test の基本設定を整える
- ルートREADMEに開発コマンドを追記する

## 受け入れ条件

- ルートから主要な開発コマンドを実行できる
- `apps` と `packages` の責務がREADMEまたはドキュメントで確認できる
- CIを追加する場合は、lintとtestが実行される

