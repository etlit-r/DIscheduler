# セキュリティ方針 / Security Policy

DIscheduler のセキュリティ方針は、Web ページとして公開しています。

- 公開ページ: `https://<デプロイ先>.workers.dev/security`
- ページのソース: [public/security.html](public/security.html)
- 設計の詳細（脅威モデル・対策・残存リスク）: [docs/security-design.md](docs/security-design.md)

## 脆弱性の報告

脆弱性を発見した場合は、**公開の Issue には書かず**、GitHub の [Private vulnerability reporting](../../security/advisories/new)（リポジトリの Security タブ →「Report a vulnerability」）から報告してください。

- 受領連絡: 3 営業日以内を目標
- 修正後、報告者の同意を得て、報告された脆弱性を GitHub Security Advisory として公開します
- 善意のセキュリティ調査は歓迎します。ただし他の利用者のデータへのアクセス、サービス妨害、ソーシャルエンジニアリングは行わないでください

サポート対象は `master` ブランチの最新版のみです。
