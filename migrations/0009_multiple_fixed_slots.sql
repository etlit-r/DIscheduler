-- 1 つの調整で、確定する候補を複数にする（docs/design.md §4.3, §5.7, §7.2）
-- 確定した時刻・Discord イベント・お知らせの状態・予定のリマインドの記録は、候補ごとに持つ。
-- polls.fixed_slot_id・polls.fixed_at・polls.discord_event_id・polls.day_reminded_slot_at は使わなくなる（移したあと NULL にする。
-- 列は残す: マイグレーションのあと新しい Worker に切り替わるまでの間も、古い Worker がエラーにならないようにするため）
ALTER TABLE slots ADD COLUMN fixed_at INTEGER;                          -- 確定した時刻。NULL = 確定していない
ALTER TABLE slots ADD COLUMN discord_event_id TEXT;                     -- この候補で登録した Discord イベント
ALTER TABLE slots ADD COLUMN announced_fixed INTEGER NOT NULL DEFAULT 0; -- 前回の［確定をお知らせする］で確定日として知らせたか
ALTER TABLE slots ADD COLUMN day_reminded_at INTEGER;                   -- 予定のリマインドを送った日時の開始時刻（§5.7）

-- これまでの確定は、確定したときにお知らせ済み
UPDATE slots SET
  fixed_at = (SELECT COALESCE(p.fixed_at, p.updated_at) FROM polls p WHERE p.fixed_slot_id = slots.id),
  discord_event_id = (SELECT p.discord_event_id FROM polls p WHERE p.fixed_slot_id = slots.id),
  announced_fixed = 1,
  day_reminded_at = (SELECT p.day_reminded_slot_at FROM polls p WHERE p.fixed_slot_id = slots.id)
WHERE id IN (SELECT fixed_slot_id FROM polls WHERE fixed_slot_id IS NOT NULL);

UPDATE polls SET fixed_slot_id = NULL, fixed_at = NULL, discord_event_id = NULL, day_reminded_slot_at = NULL
WHERE fixed_slot_id IS NOT NULL OR discord_event_id IS NOT NULL OR day_reminded_slot_at IS NOT NULL;
