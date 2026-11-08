// サーバーごとの最近使った時間帯（docs/design.md §6.3.1）
// 主催者が候補日時を追加したときの開始・終了の時刻（調整のタイムゾーンでの壁時計の時刻）を、新しい順に 3 件まで覚える。
// 誰が入れたかは保存しない。
import { epochToZoned } from "../shared/time";

export interface TimeRange {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export const RECENT_TIMES_MAX = 3;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function hhmm(epochSec: number, tz: string): string {
  const p = epochToZoned(epochSec, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function isTimeRange(v: unknown): v is TimeRange {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.start === "string" && typeof r.end === "string" && HHMM.test(r.start) && HHMM.test(r.end);
}

/** 保存値（JSON）を読む。形式が崩れていれば空として扱う */
export function parseRanges(json: string | null | undefined): TimeRange[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter(isTimeRange).slice(0, RECENT_TIMES_MAX).map((r) => ({ start: r.start, end: r.end })) : [];
  } catch {
    return [];
  }
}

/** 候補日時から時間帯を取り出す（終日と終了なしは除く。重複は除き、出てきた順） */
export function rangesFromSlots(slots: { startAt: number; endAt: number | null; allDay: boolean }[], tz: string): TimeRange[] {
  const out: TimeRange[] = [];
  for (const s of slots) {
    if (s.allDay || s.endAt === null) continue;
    const r = { start: hhmm(s.startAt, tz), end: hhmm(s.endAt, tz) };
    if (!out.some((x) => x.start === r.start && x.end === r.end)) out.push(r);
  }
  return out;
}

/** 新しく使った時間帯を先頭にして、重複を除き 3 件までにする */
export function mergeRanges(newer: TimeRange[], older: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of [...newer, ...older]) {
    if (out.length >= RECENT_TIMES_MAX) break;
    if (!out.some((x) => x.start === r.start && x.end === r.end)) out.push(r);
  }
  return out;
}

export async function getRecentTimes(db: D1Database, guildId: string): Promise<TimeRange[]> {
  const row = await db.prepare("SELECT ranges FROM guild_recent_times WHERE guild_id = ?").bind(guildId).first<{ ranges: string }>();
  return parseRanges(row?.ranges);
}

export function saveRecentTimesStatement(db: D1Database, guildId: string, ranges: TimeRange[], now: number): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO guild_recent_times (guild_id, ranges, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(guild_id) DO UPDATE SET ranges = excluded.ranges, updated_at = excluded.updated_at",
    )
    .bind(guildId, JSON.stringify(ranges), now);
}
