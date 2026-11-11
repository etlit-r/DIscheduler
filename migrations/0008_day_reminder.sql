-- 当日のリマインド（docs/design.md §5.7）
-- 送った確定日時の開始時刻（UNIX 秒）。同じ確定日時に 2 回送らないため。確定し直して日時が変わったら、改めて送る
ALTER TABLE polls ADD COLUMN day_reminded_slot_at INTEGER;
