# DIscheduler

DIscheduler（ディーアイスケジューラー）は、Discord のチャンネル／ロールのメンバーで日程調整を行う Bot です。Cloudflare（Pages・Workers・D1）の無料枠のみで動作するサーバーレス構成です。


## ドキュメント
- [設計書](docs/design.md)
- [セキュリティ設計書](docs/security-design.md)
- [セキュリティ方針（公開ページのソース）](public/security.html)
- [Bot の案内ページ（LP）のソース](public/index.html)

## デプロイ
`main` にマージすると、GitHub Actions が承認待ちになり、承認後に Cloudflare Pages（本体）と Workers（定期処理）へデプロイされます。初回の準備は [設計書](docs/design.md) の §14 を参照してください。

## サーバー管理者の方へ
コマンドを使えるチャンネルは、Discord の「サーバー設定 → 連携サービス → DIscheduler」で指定できます。そのチャンネルで誰がコマンドを打てるかは、チャンネルの発言権限で制限してください。手順は [設計書](docs/design.md) の §5.4.1 を参照してください。

## 主な機能（予定）
- チャンネルで `/schedule`（または `/di`）と入力するだけで調整を作成。チャンネルまたはロールのメンバーが参加者に自動で入る
- 主催者は Web 画面のカレンダーで候補日時を一括入力
- 参加者は Discord のボタンから本人専用リンクで ○△× を入力（ログイン不要）
- 集計表で最有力候補をハイライト、確定した日時を Discord イベントとして登録

## 開発

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

ローカルで動かすときは、`.dev.vars`（Git には含めない）に `DISCORD_PUBLIC_KEY`・`DISCORD_APPLICATION_ID`・`DISCORD_BOT_TOKEN` を書き、次を実行します。

```bash
npx wrangler d1 migrations apply DB --local
```

```bash
npm run dev
```

## 運用開始の手順

[設計書](docs/design.md) の §14.1 を参照してください。Cloudflare で D1 データベースを作り、GitHub の Environment `production` に設定値を入れて `main` にマージすると、テスト・マイグレーション・デプロイが実行されます。Bot トークンは Cloudflare のダッシュボードで Pages のプロジェクトと Worker の Secret として登録します。
