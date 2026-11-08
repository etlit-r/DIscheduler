-- 公開処理中の印（docs/design.md §5.5）。同時に公開されても募集メッセージを 1 件だけ投稿するために使う
ALTER TABLE polls ADD COLUMN publishing_at INTEGER;
