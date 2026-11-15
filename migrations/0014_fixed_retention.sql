-- 確定した調整のデータは、いちばん遅い確定日時から 10 日後に削除する（docs/design.md §7.4）。
-- これまでは 6 か月後だったので、確定済みの調整の削除時刻を決め直す。
-- いちばん遅い確定日時から 10 日を過ぎている調整は、次の日本時間 1 時の自動処理で削除される
UPDATE polls SET purge_after = (
  SELECT MAX(s.start_at) + 10 * 86400 FROM slots s WHERE s.poll_id = polls.id AND s.fixed_at IS NOT NULL
)
WHERE status = 'fixed' AND EXISTS (SELECT 1 FROM slots s WHERE s.poll_id = polls.id AND s.fixed_at IS NOT NULL);
