# Shiori

自分用のローカルファーストなノートアプリです。

まずは macOS で快適に使えるクライアントアプリとして小さく始め、後から iPhone や Web でも使える構成へ広げていきます。

## Documents

- [技術方針](docs/technical-direction.md)
- [開発チケット](docs/tickets/README.md)
- [Supabase / 同期メモ](docs/sync-and-supabase.md)

## Directory

```text
apps/
  desktop/      React / TypeScript のデスクトップ向け UI。Tauri 設定もここに配置します。
packages/
  core/         ノート、タグ、同期イベントなどの共通型とドメインロジック。
  schema/       SQLite / Supabase のスキーマとマイグレーション。
  ui/           共通 UI 部品。
  editor/       本文エディタ部品。
```

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
npm run test
```

`npm run dev` でブラウザ確認用の開発サーバーを起動します。Rust / Cargo がある環境では `npm run tauri:dev -w @shiori/desktop` で Tauri アプリとして起動する想定です。

現時点のローカル保存は、ブラウザで確認できるよう IndexedDB を使っています。Tauri 統合時は `packages/schema/migrations` の SQLite スキーマを使い、`apps/desktop/src/storage.ts` の保存層を Tauri コマンド経由の SQLite 実装へ差し替える方針です。
