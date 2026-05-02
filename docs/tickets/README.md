# Shiori 開発チケット一覧

このフォルダでは、[技術方針](../technical-direction.md) をもとにした開発チケットを、1チケット1ファイルで管理します。

初期開発では、まずローカル保存で日常利用できる最小版を作り、その後に検索、タグ、認証、差分同期、競合処理を段階的に追加します。Web 版と iPhone 版は、初期版の完了後に実現性を確認する扱いにします。

## 前提

- 初期対象は macOS クライアントです。
- UI は React / TypeScript、デスクトップアプリは Tauri を前提にします。
- ローカルDBは SQLite、全文検索は SQLite FTS5 を使います。
- クラウド側は Supabase Auth / Supabase Postgres を前提にします。
- リアルタイム共同編集、公開共有リンク、高度な添付ファイル管理、AI機能は初期スコープ外です。

## 優先度

| 優先度 | 意味 |
| --- | --- |
| P0 | 初期版の成立に必須 |
| P1 | 初期版で入れたい主要機能 |
| P2 | 初期版後半または検証タスク |

## マイルストーン

| マイルストーン | 目的 |
| --- | --- |
| M1: ローカル最小版 | macOS上でノートを作成、編集、削除できる |
| M2: 検索と整理 | 全文検索とタグでノートを探せる |
| M3: 認証と同期 | Supabaseにログインし、手動または簡易自動同期できる |
| M4: 安全性向上 | 競合時にデータを失わず、状態を確認できる |
| M5: 将来展開の確認 | Web / iPhone 展開に向けた判断材料を得る |

## チケット

| ID | タイトル | 優先度 | マイルストーン | 依存 |
| --- | --- | --- | --- | --- |
| [SHI-007](./SHI-007-sqlite-fts-search.md) | SQLite FTS5 による全文検索を実装する | P1 | M2 | SHI-003, SHI-004 |
| [SHI-009](./SHI-009-supabase-schema-auth-rls.md) | Supabase の認証、テーブル、RLS を設計する | P0 | M3 | SHI-003 |
| [SHI-010](./SHI-010-supabase-auth-desktop.md) | macOS アプリに Supabase Auth ログインを接続する | P0 | M3 | SHI-002, SHI-009 |
| [SHI-012](./SHI-012-manual-diff-sync.md) | 手動同期で push / pull できる差分同期を実装する | P0 | M3 | SHI-009, SHI-010, SHI-011 |
| [SHI-013](./SHI-013-simple-auto-sync.md) | 簡易的な自動同期を実装する | P1 | M3 | SHI-012 |
| [SHI-014](./SHI-014-sync-status-ui.md) | 同期状態とエラーをUIで確認できるようにする | P1 | M4 | SHI-012 |
| [SHI-015](./SHI-015-conflict-copy.md) | 競合時にコピーを残す処理を実装する | P0 | M4 | SHI-012 |
| [SHI-016](./SHI-016-web-feasibility.md) | Web 版の成立性を確認する | P2 | M5 | SHI-001, SHI-012 |
| [SHI-017](./SHI-017-iphone-implementation-comparison.md) | iPhone 版の実装方式を比較する | P2 | M5 | SHI-001 |

## 完了済みチケット

完了済みのチケットは [`completed`](./completed) に移動します。

| ID | タイトル | 優先度 | マイルストーン | 依存 |
| --- | --- | --- | --- | --- |
| [SHI-001](./completed/SHI-001-monorepo-foundation.md) | モノレポ構成と開発基盤を作成する | P0 | M1 | なし |
| [SHI-002](./completed/SHI-002-tauri-react-desktop-scaffold.md) | Tauri + React のデスクトップアプリ雛形を作成する | P0 | M1 | SHI-001 |
| [SHI-003](./completed/SHI-003-sqlite-schema-migrations.md) | SQLite スキーマとマイグレーション基盤を整備する | P0 | M1 | SHI-001 |
| [SHI-004](./completed/SHI-004-local-note-crud.md) | ノートの作成、編集、削除をローカルDBで実装する | P0 | M1 | SHI-002, SHI-003 |
| [SHI-005](./completed/SHI-005-editor-autosave.md) | 本文エディタと自動保存を実装する | P0 | M1 | SHI-004 |
| [SHI-006](./completed/SHI-006-soft-delete-notes.md) | 削除済みノートを `deleted_at` で扱う | P0 | M1 | SHI-004 |
| [SHI-008](./completed/SHI-008-tags.md) | タグ付けとタグ検索を実装する | P1 | M2 | SHI-003, SHI-004 |
| [SHI-011](./completed/SHI-011-sync-events.md) | ローカル変更を `sync_events` に記録する | P0 | M3 | SHI-004, SHI-006 |

## 初期リリース判定

初期版は、少なくとも次の状態を満たした時点で日常利用の開始候補とします。

- macOS アプリとして起動できる
- ノートをローカルに作成、編集、削除できる
- アプリ再起動後もデータが保持される
- タイトルと本文を検索できる
- タグでノートを整理できる
- Supabase にログインできる
- 手動同期でクラウドへ反映できる
- 競合時に片方の内容が失われない
