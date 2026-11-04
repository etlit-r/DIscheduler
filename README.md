# DIscheduler

Discord のチャンネル／ロールのメンバーで日程調整を行う Bot。Cloudflare Workers の無料枠のみで動作するサーバーレス構成です。

> 現在は設計フェーズです。

## ドキュメント
- [設計書](docs/design.md)
- [セキュリティ設計書](docs/security-design.md)
- [セキュリティ方針（公開）](SECURITY.md)

## 主な機能（予定）
- `/schedule create` でチャンネルまたはロールのメンバーを参加者として自動設定
- 主催者は Web 画面のカレンダーで候補日時を一括入力
- 参加者は Discord のボタンから本人専用リンクで ○△× を入力（ログイン不要）
- 集計表で最有力候補をハイライト、確定した日時を Discord イベントとして登録
