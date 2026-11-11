// 予定のリマインド（docs/design.md §5.7）
// 日本時間 10 時と 17 時の Cron で、確定した日時が近い調整のチャンネルへ知らせる。
// - 10 時の回: 当日の 11:00〜17:59:59 に始まる予定
// - 17 時の回: 当日の 18:00〜23:59:59 と、翌日の 0:00〜10:59:59 に始まる予定、翌日の終日の予定
// 当日の予定は「今日」、翌日の予定は「明日」と書く。
// Cron は各時刻の 0〜4 分に 1 分おきに 5 回動き、1 回で DAY_REMINDER_MAX_PER_RUN 件まで送る（残りは次の分の回）。
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

/** 時刻を決めた予定（終日でない）の範囲と、終日の予定の範囲（UNIX 秒。from は含み、to は含まない） */
export interface ReminderWindow {
  timed: { from: number; to: number };
  allDay: { from: number; to: number } | null;
  /** 翌日 0:00。これ以降に始まる予定は「明日」と書く */
  tomorrow: number;
}

/** Cron の実行時刻（ミリ秒）から、その回で知らせる範囲を決める。10 時・17 時の回でなければ null */
export function reminderWindow(scheduledTime: number): ReminderWindow | null {
  const sec = Math.floor(scheduledTime / 1000);
  const dayStart = Math.floor((sec + JST_OFFSET) / (24 * HOUR)) * 24 * HOUR - JST_OFFSET;
  const hourJst = Math.floor((sec - dayStart) / HOUR);
  const tomorrow = dayStart + 24 * HOUR;
  if (hourJst === 10) return { timed: { from: dayStart + 11 * HOUR, to: dayStart + 18 * HOUR }, allDay: null, tomorrow };
  if (hourJst === 17) return { timed: { from: dayStart + 18 * HOUR, to: tomorrow + 11 * HOUR }, allDay: { from: tomorrow, to: tomorrow + 24 * HOUR }, tomorrow };
  return null;
}

type Target = Pick<PollRow, "id" | "guild_id" | "channel_id" | "message_id" | "title" | "target_type" | "target_id"> & { start_at: number; all_day: number };

export async function runDayReminder(env: Env, scheduledTime: number): Promise<void> {
  const w = reminderWindow(scheduledTime);
  if (!w) return;
  const db = env.DB;
  // 確定した候補が範囲の中で始まり、その日時についてまだ送っていない調整。
  // 終日の予定は、開始時刻（調整のタイムゾーンでのその日の 0:00）が日本時間の翌日にあるものだけ
  const allDay = w.allDay ?? { from: 0, to: 0 };
  const where =
    "FROM polls p JOIN slots s ON s.id = p.fixed_slot_id " +
    "WHERE p.status = 'fixed' " +
    "AND ((s.all_day = 0 AND s.start_at >= ? AND s.start_at < ?) OR (s.all_day = 1 AND s.start_at >= ? AND s.start_at < ?)) " +
    "AND (p.day_reminded_slot_at IS NULL OR p.day_reminded_slot_at != s.start_at)";
  const binds = [w.timed.from, w.timed.to, allDay.from, allDay.to];
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n ${where}`).bind(...binds),
    db.prepare(`SELECT p.id, p.guild_id, p.channel_id, p.message_id, p.title, p.target_type, p.target_id, s.start_at, s.all_day ${where} ORDER BY s.start_at, p.id LIMIT ?`).bind(...binds, DAY_REMINDER_MAX_PER_RUN),
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
      await discord(env, "POST", `/channels/${t.channel_id}/messages`, buildDayReminderMessage(t, { startAt: t.start_at, allDay: t.all_day === 1, isTomorrow: t.start_at >= w.tomorrow }));
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
