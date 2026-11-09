export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Discord Developer Portal の Public Key（公開値） */
  DISCORD_PUBLIC_KEY: string;
  /** Discord の Application ID（公開値） */
  DISCORD_APPLICATION_ID: string;
  /** Bot トークン（Cloudflare の Secret として登録する） */
  DISCORD_BOT_TOKEN: string;
  /**
   * 正式な公開アドレス（例: https://discheduler.pages.dev。docs/design.md §14）。
   * 入力リンクや案内のアドレスに使う。これと違うアドレスへのアクセスは、正式なアドレスへ転送する
   * （旧アドレスの Worker や、Pages のデプロイごとの別名のアドレス）。未設定ならリクエストのアドレスを使う（テスト・開発用）
   */
  PUBLIC_ORIGIN?: string;
  /** 寄付リンク（任意） */
  DONATION_URL?: string;
  /** "1" のとき Web API と Discord の操作を止める（インシデント対応用。security-design §7） */
  MAINTENANCE?: string;
  /** テスト用: Discord API の接続先 */
  DISCORD_API_BASE?: string;
}
