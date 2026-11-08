-- 回答が集まったあとに選択肢を変えた時刻（docs/design.md §6.9.4）。回答画面で「選択肢が変更されました」を出すのに使う
ALTER TABLE polls ADD COLUMN choices_changed_at INTEGER;
