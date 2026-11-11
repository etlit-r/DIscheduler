// 予定のリマインド（docs/design.md §5.7）
// 日本時間 10 時と 17 時の Cron で、確定した日時が近い調整のチャンネルへ知らせる。
// - 10 時の回: 当日の 11:00〜17:59:59 に始まる予定
// - 17 時の回: 当日の 18:00〜23:59:59 と、翌日の 0:00〜10:59:59 に始まる予定、翌日の終日の予定
// Cron は各時刻の 0〜4 分に 1 分おきに 5 回動き、1 回で DAY_REMINDER_MAX_PER_RUN 件まで送る（残りは次の分の回）。
// 回が過ぎてから確定した予定は、［確定をお知らせする］のお知らせにリマインドの一文を添える（reminderRunAt。§5.7）。
import type { Env } from "../core/env";
import type { PollRow } from "../db";
import { buildDayReminderMessage } from "../discord/messages";
import { discord, DiscordError } from "../discord/rest";
import { epochToZoned } from "../shared/time";

/**
 * 1 回の実行で送る数の上限。無料プランでは、Discord への送信（サブリクエスト）と D1 の問い合わせが、
 * それぞれ 1 回の実行あたり 50 回まで。対象の読み込み 1 文と、1 件ごとに権利の取得 1 文・送信 1 回を使う
 */
export const DAY_REMINDER_MAX_PER_RUN = 20;

const HOUR = 3600;
const DAY = 24 * HOUR;
/** 日本時間（UTC+9。夏時間なし） */
const JST_OFFSET = 9 * HOUR;
/**
 * 終日の候補の開始時刻（調整のタイムゾーンでのその日の 0:00）は、日本時間の 0:00 から見て -5〜+21 時間にある
 * （UTC-12〜UTC+14 のタイムゾーン）。この幅で広めに読み、調整のタイムゾーンでの日付で絞り込む
 */
const ALL_DAY_BEFORE = 5 * HOUR;
const ALL_DAY_AFTER = 21 * HOUR;

/** 日本時間のその日の 0:00（UNIX 秒） */
function jstDayStart(sec: number): number {
  return Math.floor((sec + JST_OFFSET) / DAY) * DAY - JST_OFFSET;
}

/** 日本時間の日付（"2026-11-07"） */
function jstDate(sec: number): string {
  return new Date((sec + JST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** 調整のタイムゾーンでの日付（"2026-11-07"） */
function zonedDate(sec: number, tz: string): string {
  const p = epochToZoned(sec, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** その回で知らせる範囲（UNIX 秒。from は含み、to は含まない） */
export interface ReminderWindow {
  /** 時刻を決めた予定（終日でない） */
  timed: { from: number; to: number };
  /** 終日の予定は、調整のタイムゾーンでの日付がこの日（日本時間の翌日の日付）のもの。10 時の回は null */
  allDayDate: string | null;
}

/** Cron の実行時刻（ミリ秒）から、その回で知らせる範囲を決める。10 時・17 時の回でなければ null */
export function reminderWindow(scheduledTime: number): ReminderWindow | null {
  const sec = Math.floor(scheduledTime / 1000);
  const dayStart = jstDayStart(sec);
  const hourJst = Math.floor((sec - dayStart) / HOUR);
  const tomorrow = dayStart + DAY;
  if (hourJst === 10) return { timed: { from: dayStart + 11 * HOUR, to: dayStart + 18 * HOUR }, allDayDate: null };
  if (hourJst === 17) return { timed: { from: dayStart + 18 * HOUR, to: tomorrow + 11 * HOUR }, allDayDate: jstDate(tomorrow) };
  return null;
}

/**
 * その予定を知らせる回の時刻（UNIX 秒。各時刻の 0 分）。
 * 時刻を決めた予定: 0:00〜10:59 は前日 17 時、11:00〜17:59 は当日 10 時、18:00〜23:59 は当日 17 時。
 * 終日の予定: 調整のタイムゾーンでの日付の前日 17 時（日本時間）
 */
export function reminderRunAt(slot: { start_at: number; all_day: number }, timezone: string): number {
  if (slot.all_day === 1) {
    const [y, m, d] = zonedDate(slot.start_at, timezone).split("-").map(Number) as [number, number, number];
    const dateStartJst = Date.UTC(y, m - 1, d) / 1000 - JST_OFFSET;
    return dateStartJst - DAY + 17 * HOUR;
  }
  const dayStart = jstDayStart(slot.start_at);
  const hourJst = Math.floor((slot.start_at - dayStart) / HOUR);
  if (hourJst < 11) return dayStart - DAY + 17 * HOUR;
  if (hourJst < 18) return dayStart + 10 * HOUR;
  return dayStart + 17 * HOUR;
}

type Target = Pick<PollRow, "id" | "guild_id" | "channel_id" | "message_id" | "title" | "target_type" | "target_id" | "timezone"> & { slot_id: string; start_at: number; all_day: number };

export async function runDayReminder(env: Env, scheduledTime: number): Promise<void> {
  const w = reminderWindow(scheduledTime);
  if (!w) return;
  const db = env.DB;
  // 確定した候補が範囲の中で始まり、その日時についてまだ送っていないもの（確定した候補が複数ある調整は、候補ごとに送る）。
  // 終日の予定は広めに読み、調整のタイムゾーンでの日付で絞り込む
  const allDayFrom = w.allDayDate ? Date.parse(`${w.allDayDate}T00:00:00+09:00`) / 1000 - ALL_DAY_BEFORE : 0;
  const allDayTo = w.allDayDate ? allDayFrom + ALL_DAY_BEFORE + ALL_DAY_AFTER + 1 : 0;
  const rows = await db
    .prepare(
      "SELECT s.id AS slot_id, p.id, p.guild_id, p.channel_id, p.message_id, p.title, p.target_type, p.target_id, p.timezone, s.start_at, s.all_day " +
        "FROM slots s JOIN polls p ON p.id = s.poll_id " +
        "WHERE p.status = 'fixed' AND s.fixed_at IS NOT NULL " +
        "AND ((s.all_day = 0 AND s.start_at >= ? AND s.start_at < ?) OR (s.all_day = 1 AND s.start_at >= ? AND s.start_at < ?)) " +
        "AND (s.day_reminded_at IS NULL OR s.day_reminded_at != s.start_at) " +
        "ORDER BY s.start_at, p.id LIMIT ?",
    )
    .bind(w.timed.from, w.timed.to, allDayFrom, allDayTo, DAY_REMINDER_MAX_PER_RUN + 1)
    .all<Target>();
  // 上限より 1 件多く読み、残りがあるかだけを知る（ログ用）
  const deferred = rows.results.length > DAY_REMINDER_MAX_PER_RUN;
  const targets = rows.results.slice(0, DAY_REMINDER_MAX_PER_RUN).filter((t) => t.all_day === 0 || zonedDate(t.start_at, t.timezone) === w.allDayDate);

  let sent = 0;
  let failed = 0;
  for (const t of targets) {
    // 送る前に権利を取る。Cron が重なっても、同じ確定日時には 1 回だけ送る。送信に失敗しても戻さない
    const claimed = await db
      .prepare("UPDATE slots SET day_reminded_at = ? WHERE id = ? AND (day_reminded_at IS NULL OR day_reminded_at != ?)")
      .bind(t.start_at, t.slot_id, t.start_at)
      .run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await discord(env, "POST", `/channels/${t.channel_id}/messages`, buildDayReminderMessage(t, { startAt: t.start_at, allDay: t.all_day === 1, timezone: t.timezone }));
      sent++;
    } catch (e) {
      // チャンネルが消えている・Bot が投稿できない（403・404）ときも、ほかの調整の処理は続ける
      failed++;
      if (!(e instanceof DiscordError && (e.status === 403 || e.status === 404))) {
        console.error(JSON.stringify({ event: "day_reminder_failed", error: e instanceof Error ? e.message : "unknown" }));
      }
    }
  }
  console.log(JSON.stringify({ event: "day_reminder", sent, deferred, failed }));
}
