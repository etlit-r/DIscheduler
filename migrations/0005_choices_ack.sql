-- 参加者が「選択肢が変更されました」を確認した選択肢の版（docs/design.md §6.9.4）
ALTER TABLE participants ADD COLUMN choices_ack_version INTEGER;
