-- DIscheduler 初期スキーマ（docs/design.md §7.2）

-- 調整
CREATE TABLE polls (
  id               TEXT PRIMARY KEY,                    -- ランダム 128bit (base64url)
  guild_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  message_id       TEXT,                                -- 募集メッセージ
  organizer_id     TEXT NOT NULL,                       -- Discord user ID
  title            TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 100), -- 下書きでは NULL 可。公開時に必須
  description      TEXT CHECK (description IS NULL OR length(description) <= 1000),
  timezone         TEXT NOT NULL DEFAULT 'Asia/Tokyo',  -- IANA 名
  timezone_set     INTEGER NOT NULL DEFAULT 0,          -- 1 = 主催者が設定済み
  target_type      TEXT NOT NULL CHECK (target_type IN ('channel','role','manual')),
  target_id        TEXT,                                -- role のときのロール ID
  join_policy      TEXT NOT NULL DEFAULT 'closed' CHECK (join_policy IN ('closed','open')),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','open','closed','fixed','cancelled')),
  deadline_at      INTEGER,                             -- UNIX 秒 (UTC)
  fixed_slot_id    TEXT,
  fixed_at         INTEGER,                             -- 確定した時刻
  discord_event_id TEXT,
  choices_version  INTEGER NOT NULL DEFAULT 1,
  last_synced_at   INTEGER,                             -- 募集メッセージの最終更新
  last_reminded_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  purge_after      INTEGER NOT NULL                     -- この時刻以降に物理削除
);
CREATE INDEX idx_polls_channel ON polls(guild_id, channel_id, status);
CREATE INDEX idx_polls_purge ON polls(purge_after);
CREATE INDEX idx_polls_draft ON polls(organizer_id, channel_id, status);

-- 候補日時
CREATE TABLE slots (
  id        TEXT PRIMARY KEY,
  poll_id   TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  start_at  INTEGER NOT NULL,
  end_at    INTEGER,
  all_day   INTEGER NOT NULL DEFAULT 0,
  position  INTEGER NOT NULL,
  UNIQUE (poll_id, start_at, end_at)
);
CREATE INDEX idx_slots_poll ON slots(poll_id);

-- 回答の選択肢（調整ごとに 2〜5 個）
CREATE TABLE choices (
  id        TEXT PRIMARY KEY,
  poll_id   TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  symbol    TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 8),
  label     TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 10),
  kind      TEXT NOT NULL CHECK (kind IN ('ok','maybe','ng')),
  score     INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
  color     TEXT NOT NULL CHECK (color IN ('green','teal','yellow','orange','red','gray')),
  position  INTEGER NOT NULL,
  UNIQUE (poll_id, label)
);
CREATE INDEX idx_choices_poll ON choices(poll_id);

-- 参加者
CREATE TABLE participants (
  poll_id       TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  display_name  TEXT NOT NULL CHECK (length(display_name) <= 64),
  comment       TEXT CHECK (comment IS NULL OR length(comment) <= 100),
  answered_at   INTEGER,
  PRIMARY KEY (poll_id, user_id)
);

-- 回答
CREATE TABLE answers (
  poll_id        TEXT NOT NULL,
  slot_id        TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL,
  choice_id      TEXT NOT NULL REFERENCES choices(id),
  prev_choice_id TEXT,                                  -- 確定後に変更した場合の、確定時点の選択肢
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (slot_id, user_id),
  FOREIGN KEY (poll_id, user_id) REFERENCES participants(poll_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_answers_poll ON answers(poll_id);
CREATE INDEX idx_answers_updated ON answers(poll_id, updated_at);

-- 入力リンク用ワンタイムトークン（ハッシュのみ保存）
CREATE TABLE link_tokens (
  token_hash  TEXT PRIMARY KEY,
  poll_id     TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('organizer','participant')),
  purpose     TEXT NOT NULL CHECK (purpose IN ('edit','answer','view')),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_link_tokens_exp ON link_tokens(expires_at);

-- Web セッション（ハッシュのみ保存）
CREATE TABLE sessions (
  sid_hash    TEXT PRIMARY KEY,
  poll_id     TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('organizer','participant')),
  csrf_token  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_exp ON sessions(expires_at);
CREATE INDEX idx_sessions_poll_user ON sessions(poll_id, user_id);

-- レート制限カウンタ（固定ウィンドウ）
CREATE TABLE rate_limits (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- アプリの内部状態（登録済みコマンドの版など）
CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
