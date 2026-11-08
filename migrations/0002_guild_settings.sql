-- サーバーごとの既定値（docs/design.md §5.3.1）
-- 主催者が /schedule でオプションを指定しなかったときの、参加者の決め方
CREATE TABLE guild_settings (
  guild_id    TEXT PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT 'channel' CHECK (mode IN ('channel','role','manual')),
  role_id     TEXT,                                  -- mode = role のときのロール ID
  updated_by  TEXT NOT NULL,                         -- 最後に変更した管理者の Discord user ID
  updated_at  INTEGER NOT NULL
);
