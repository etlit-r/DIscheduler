-- 1 つの調整で、確定する候補を複数にする（docs/design.md §4.3, §7.2）
-- 確定した時刻と Discord イベントは、候補ごとに持つ。
-- polls.fixed_slot_id・polls.fixed_at・polls.discord_event_id は使わなくなる（移したあと NULL にする。
-- 列は残す: マイグレーションのあと新しい Worker に切り替わるまでの間も、古い Worker がエラーにならないようにするため）
ALTER TABLE slots ADD COLUMN fixed_at INTEGER;          -- 確定した時刻。NULL = 確定していない
ALTER TABLE slots ADD COLUMN discord_event_id TEXT;     -- この候補で登録した Discord イベント

UPDATE slots SET
  fixed_at = (SELECT COALESCE(p.fixed_at, p.updated_at) FROM polls p WHERE p.fixed_slot_id = slots.id),
  discord_event_id = (SELECT p.discord_event_id FROM polls p WHERE p.fixed_slot_id = slots.id)
WHERE id IN (SELECT fixed_slot_id FROM polls WHERE fixed_slot_id IS NOT NULL);

UPDATE polls SET fixed_slot_id = NULL, fixed_at = NULL, discord_event_id = NULL WHERE fixed_slot_id IS NOT NULL OR discord_event_id IS NOT NULL;
