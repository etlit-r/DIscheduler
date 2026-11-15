-- 使わなくなった列を消す（docs/design.md §7.2）
-- fixed_slot_id・fixed_at・discord_event_id・day_reminded_slot_at: 0009 で slots の列に移した（古い Worker のために残していた）
-- last_reminded_at: リマインドの回数は rate_limits（remind:{pollId}）で数えるようにした
-- いま動いている Worker はどれも読み書きしないので、マイグレーションのあとにデプロイが切り替わるまでの間もエラーにならない
ALTER TABLE polls DROP COLUMN fixed_slot_id;
ALTER TABLE polls DROP COLUMN fixed_at;
ALTER TABLE polls DROP COLUMN discord_event_id;
ALTER TABLE polls DROP COLUMN day_reminded_slot_at;
ALTER TABLE polls DROP COLUMN last_reminded_at;
