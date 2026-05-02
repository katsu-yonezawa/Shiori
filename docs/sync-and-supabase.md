# Supabase / 同期メモ

## 現時点の方針

初期版では、ローカル操作を先に保存し、変更内容を `sync_events` に記録します。クラウド同期はこのイベントをまとめて push し、サーバー側の更新を pull してローカルへ反映する構成にします。

このリポジトリには次の土台を置いています。

- SQLite 用スキーマ: `packages/schema/migrations/0001_initial.sql`
- Supabase 用スキーマと RLS: `packages/schema/supabase/001_initial.sql`
- ローカル同期イベントの型: `packages/core/src/types.ts`
- 競合コピーの判定補助: `packages/core/src/sync.ts`

## Auth

デスクトップアプリでは、初期方式として Magic Link またはメール OTP を想定します。OAuth はブラウザ遷移と deep link の扱いが増えるため、最初は後回しにします。

未ログイン時は、ローカル保存のみを許可し、同期ボタンは Supabase 接続処理を実行しない扱いにします。ログイン後に `user_id` を付与し、未送信の `sync_events` を push します。

## RLS

Supabase 側の各テーブルは `user_id = auth.uid()` を基準に RLS を設定します。`notes`、`tags`、`note_tags`、`sync_events` は、ログイン中のユーザーが自分のデータだけを読み書きできる設計です。

## 同期イベント

初期イベントは次の種類に絞ります。

| type | 内容 |
| --- | --- |
| `note.created` | ノート作成 |
| `note.updated` | タイトルまたは本文更新 |
| `note.deleted` | `deleted_at` による論理削除 |
| `tags.updated` | ノートへのタグ付け変更 |

イベント状態は `pending`、`syncing`、`sent`、`failed` を使います。失敗時はイベントを消さず、再試行できるようにします。

## 競合

同じノートが複数端末で更新された場合は、`version` と `updated_at` を使って検出します。初期実装では自動マージせず、片方を次の形式で残します。

```text
元のタイトル（競合コピー YYYY/MM/DD HH:mm）
```

これにより、どちらかの本文を黙って失う状態を避けます。

## 未完了の確認

Supabase プロジェクトの URL、Anon Key、認証方式が確定してから、次の項目を実環境で確認します。

- Auth のログイン、ログアウト、セッション復元
- RLS により他ユーザーのデータが読めないこと
- `sync_events` の push と pull
- 複数端末相当の競合発生と競合コピー作成
