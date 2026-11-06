# DIscheduler

Discord のチャンネル／ロールのメンバーで日程調整を行う Bot。Cloudflare Workers の無料枠のみで動作するサーバーレス構成です。

> 現在は設計フェーズです。

## ドキュメント
- [設計書](docs/design.md)
- [セキュリティ設計書](docs/security-design.md)
- [セキュリティ方針（公開ページのソース）](public/security.html)
- [Bot の案内ページ（LP）のソース](public/index.html)

## デプロイ
`main` にマージすると、GitHub Actions が承認待ちになり、承認後に Cloudflare Workers へデプロイされます。初回の準備は [設計書](docs/design.md) の §14 を参照してください。

## サーバー管理者の方へ
コマンドを使えるチャンネルは、Discord の「サーバー設定 → 連携サービス → DIscheduler」で指定できます。そのチャンネルで誰がコマンドを打てるかは、チャンネルの発言権限で制限してください。手順は [設計書](docs/design.md) の §5.4.1 を参照してください。

## 主な機能（予定）
- チャンネルで `/schedule` と入力するだけで調整を作成。チャンネルまたはロールのメンバーが参加者に自動で入る
- 主催者は Web 画面のカレンダーで候補日時を一括入力
- 参加者は Discord のボタンから本人専用リンクで ○△× を入力（ログイン不要）
- 集計表で最有力候補をハイライト、確定した日時を Discord イベントとして登録
