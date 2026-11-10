-- 主催者の調整一覧（S9。docs/design.md §6.11）用のワンタイムトークンとセッション
-- サーバー（guild）単位で、そのサーバーで自分が主催した調整だけを扱う。調整ごとのセッション（sessions）とは別に持つ
CREATE TABLE list_tokens (
  token_hash  TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_list_tokens_exp ON list_tokens(expires_at);

CREATE TABLE list_sessions (
  sid_hash    TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  csrf_token  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_list_sessions_exp ON list_sessions(expires_at);
CREATE INDEX idx_list_sessions_guild ON list_sessions(guild_id);
