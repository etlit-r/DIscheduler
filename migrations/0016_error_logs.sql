-- エラーの要約（docs/design.md §12）。Cloudflare Pages はログを残さないので、予期しないエラーだけを D1 に残す。
-- 個人の情報（回答・表示名・ユーザー ID・トークン・IP アドレス）は入れない。7 日たったら日本時間 1 時の Cron で消す
CREATE TABLE error_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,                      -- 起きた時刻（UNIX 秒）
  event    TEXT NOT NULL,                         -- 種類（unhandled_error・interaction_error・sync_failed など）
  ref      TEXT,                                  -- 利用者の画面に出した参照番号（あれば）
  poll_id  TEXT,                                  -- 関係する調整（あれば）
  message  TEXT NOT NULL                          -- エラーの文（300 文字まで。Discord の API のアドレスのトークンは伏せたもの）
);
CREATE INDEX idx_error_logs_at ON error_logs(at);
