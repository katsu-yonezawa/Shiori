# SHI-003 SQLite スキーマとマイグレーション基盤を整備する

## 概要

| 項目 | 内容 |
| --- | --- |
| 優先度 | P0 |
| マイルストーン | M1: ローカル最小版 |
| 依存 | SHI-001 |

## 目的

ノート、タグ、同期に必要なローカルDBの土台を作ります。

## 作業内容

- `notes`、`tags`、`note_tags`、`sync_events` の初期スキーマを定義する
- `notes` に `deleted_at`、`version`、`device_id`、`sync_status` を含める
- マイグレーションの実行方法を整える
- DB初期化処理を `packages/schema` から利用できる形にする

## 受け入れ条件

- 新規環境でSQLite DBを作成できる
- マイグレーションを再実行しても破綻しない
- スキーマ定義とTypeScript型の対応が確認できる

