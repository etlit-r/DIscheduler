-- サーバーごとの既定値に、Discord イベントのボイスチャンネルを足す（docs/design.md §5.3.1）
-- 入っていれば、確定の画面で「ボイスチャンネル」とこのチャンネルが最初から選ばれる。NULL なら「場所を入力」
ALTER TABLE guild_settings ADD COLUMN event_channel_id TEXT;
