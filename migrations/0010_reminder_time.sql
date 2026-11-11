-- 予定のリマインドの日時を、調整ごとに主催者が決める（docs/design.md §5.7）
-- 確定した日時ごとに、その日（remind_day_offset = 0）か前日（1）の remind_hour 時（調整のタイムゾーン）に送る。既定は当日の 17 時
ALTER TABLE polls ADD COLUMN remind_day_offset INTEGER NOT NULL DEFAULT 0 CHECK (remind_day_offset IN (0, 1));
ALTER TABLE polls ADD COLUMN remind_hour INTEGER NOT NULL DEFAULT 17 CHECK (remind_hour BETWEEN 0 AND 23);
