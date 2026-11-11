// 当日のリマインド（docs/design.md §5.7）
// 確定した日時が日本時間で当日の 19:00〜24:00 に始まる調整に、19 時の Cron で調整のチャンネルへ知らせる。
// Cron は 19:00〜19:04 に 1 分おきに 5 回動き、1 回で DAY_REMINDER_MAX_PER_RUN 件まで送る（残りは次の分の回）。
import type { Env } from "../core/env";
import type { PollRow } from "../db";
import { buildDayReminderMessage } from "../discord/messages";
import { discord, DiscordError } from "../discord/rest";

/**
 * 1 回の実行で送る数の上限。無料プランでは、Discord への送信（サブリクエスト）と D1 の問い合わせが、
 * それぞれ 1 回の実行あたり 50 回まで。対象の数え上げ 1 文・対象の読み込み 1 文と、1 件ごとに権利の取得 1 文・送信 1 回を使う
 */
export const DAY_REMINDER_MAX_PER_RUN = 20;

const HOUR = 3600;
/** 日本時間（UTC+9。夏時間なし） */
const JST_OFFSET = 9 * HOUR;

/** scheduledTime（ミリ秒）の日本時間での当日 19:00 と、翌日 0:00（UNIX 秒） */
export function dayReminderRange(scheduledTime: number): { from: number; to: number } {
  const sec = Math.floor(scheduledTime / 1000);
  const dayStart = Math.floor((sec + JST_OFFSET) / (24 * HOUR)) * 24 * HOUR - JST_OFFSET;
  return { from: dayStart + 19 * HOUR, to: dayStart + 24 * HOUR };
}

type Target = Pick<PollRow, "id" | "guild_id" | "channel_id" | "message_id" | "title" | "target_type" | "target_id"> & { start_at: number };

export async function runDayReminder(env: Env, scheduledTime: number): Promise<void> {
  const db = env.DB;
  const { from, to } = dayReminderRange(scheduledTime);
  // 確定した候補が当日 19 時以降に始まり（終日は除く）、その日時についてまだ送っていない調整
  const where =
    "FROM polls p JOIN slots s ON s.id = p.fixed_slot_id " +
    "WHERE p.status = 'fixed' AND s.all_day = 0 AND s.start_at >= ? AND s.start_at < ? " +
    "AND (p.day_reminded_slot_at IS NULL OR p.day_reminded_slot_at != s.start_at)";
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n ${where}`).bind(from, to),
    db.prepare(`SELECT p.id, p.guild_id, p.channel_id, p.message_id, p.title, p.target_type, p.target_id, s.start_at ${where} ORDER BY s.start_at, p.id LIMIT ?`).bind(from, to, DAY_REMINDER_MAX_PER_RUN),
  ]);
  const total = (count!.results[0] as { n: number } | undefined)?.n ?? 0;
  const targets = rows!.results as Target[];

  let sent = 0;
  let failed = 0;
  for (const t of targets) {
    // 送る前に権利を取る。Cron が重なっても、同じ確定日時には 1 回だけ送る。送信に失敗しても戻さない
    const claimed = await db
      .prepare("UPDATE polls SET day_reminded_slot_at = ? WHERE id = ? AND (day_reminded_slot_at IS NULL OR day_reminded_slot_at != ?)")
      .bind(t.start_at, t.id, t.start_at)
      .run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await discord(env, "POST", `/channels/${t.channel_id}/messages`, buildDayReminderMessage(t, t.start_at));
      sent++;
    } catch (e) {
      // チャンネルが消えている・Bot が投稿できない（403・404）ときも、ほかの調整の処理は続ける
      failed++;
      if (!(e instanceof DiscordError && (e.status === 403 || e.status === 404))) {
        console.error(JSON.stringify({ event: "day_reminder_failed", error: e instanceof Error ? e.message : "unknown" }));
      }
    }
  }
  console.log(JSON.stringify({ event: "day_reminder", sent, deferred: Math.max(0, total - targets.length), failed }));
}
