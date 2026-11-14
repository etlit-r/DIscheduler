-- サーバーごとの既定値に、Discord イベントの場所を足す（docs/design.md §5.3.1）
-- 確定の画面で「場所を入力」の欄に最初から入る文字。NULL なら「Discord」
ALTER TABLE guild_settings ADD COLUMN event_location TEXT;
