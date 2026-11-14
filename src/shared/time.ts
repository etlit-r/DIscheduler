// タイムゾーンの扱い（docs/design.md §6.7）
// 表示の書式は日本語と英語で分ける（§6.11）。言語を渡さなければ日本語。
// サーバーは UTC の UNIX 秒で保存し、表示と入力はブラウザ側で IANA タイムゾーンを使って変換する。

export const DEFAULT_TIMEZONE = "Asia/Tokyo";

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return false;
  }
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (supported) {
    const list = supported("timeZone");
    return list.includes(tz) || tz === "UTC";
  }
  return true;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(epochMs: number, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second! };
}

/** タイムゾーンのオフセット（ミリ秒。UTC より進んでいれば正） */
export function zoneOffsetMs(epochMs: number, tz: string): number {
  const p = partsInZone(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** あるタイムゾーンの壁時計の日時 → UNIX 秒 */
export function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let offset = zoneOffsetMs(guess, tz);
  let epoch = guess - offset;
  // 夏時間の境目で 1 回だけ補正
  const offset2 = zoneOffsetMs(epoch, tz);
  if (offset2 !== offset) {
    offset = offset2;
    epoch = guess - offset;
  }
  return Math.floor(epoch / 1000);
}

/** UNIX 秒 → タイムゾーンでの年月日時分 */
export function epochToZoned(epochSec: number, tz: string): Parts {
  return partsInZone(epochSec * 1000, tz);
}

import type { Lang } from "./i18n";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 例: 11/12(水)、英語では Wed, Nov 12 */
export function formatDate(epochSec: number, tz: string, lang: Lang = "ja"): string {
  const p = epochToZoned(epochSec, tz);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  if (lang === "en") return `${WEEKDAYS_EN[wd]}, ${MONTHS_EN[p.month - 1]} ${p.day}`;
  return `${p.month}/${p.day}(${WEEKDAYS[wd]})`;
}

/** 例: 20:00 */
export function formatTime(epochSec: number, tz: string): string {
  const p = epochToZoned(epochSec, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** タイムゾーンの短い名前（例: JST, GMT+9, CET） */
export function zoneAbbr(epochSec: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(epochSec * 1000));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  if (tz === "Asia/Tokyo") return "JST";
  return name;
}

export interface SlotTime {
  startAt: number;
  endAt: number | null;
  allDay: boolean;
}

/** 例: 11/12(水) 20:00–22:00 / 11/12(水) 終日 */
export function formatSlot(slot: SlotTime, tz: string, lang: Lang = "ja"): string {
  return `${formatDate(slot.startAt, tz, lang)} ${formatSlotTime(slot, tz, lang)}`;
}

/** 日付を除いた時間帯。例: 20:00–22:00 / 終日 / 23:00–11/13(金) 01:00（日付を見出しにまとめて表示するとき。日付をまたぐときは終わりの日付を残す） */
export function formatSlotTime(slot: SlotTime, tz: string, lang: Lang = "ja"): string {
  if (slot.allDay) return lang === "en" ? "All day" : "終日";
  const start = formatTime(slot.startAt, tz);
  if (slot.endAt === null) return lang === "en" ? `${start}–` : `${start}〜`;
  const end = formatTime(slot.endAt, tz);
  const endDate = formatDate(slot.endAt, tz, lang);
  return endDate === formatDate(slot.startAt, tz, lang) ? `${start}–${end}` : `${start}–${endDate} ${end}`;
}

/** 例: 11/12(水) 20:00 */
export function formatDateTime(epochSec: number, tz: string, lang: Lang = "ja"): string {
  return `${formatDate(epochSec, tz, lang)} ${formatTime(epochSec, tz)}`;
}

/** 次の自動更新（日本時間 1 時・13 時 = UTC 16 時・4 時）の UNIX 秒 */
export function nextCronAt(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const candidates = [4, 16, 28].map((h) => base / 1000 + h * 3600);
  return candidates.find((t) => t > nowSec) ?? candidates[2]!;
}
