-- サーバーごとの最近使った時間帯（docs/design.md §6.3.1）
-- 作成画面の「最近使った」に出す。時刻だけを保存し、誰が入れたかは保存しない
CREATE TABLE guild_recent_times (
  guild_id    TEXT PRIMARY KEY,
  ranges      TEXT NOT NULL,                         -- JSON 配列 [{"start":"20:00","end":"22:00"}, ...]（新しい順・最大 3 件）
  updated_at  INTEGER NOT NULL
);
