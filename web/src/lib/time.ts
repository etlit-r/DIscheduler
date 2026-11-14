// 日時の表示を、画面の言語に合わせて呼ぶための薄い包み（docs/design.md §6.12）
import * as base from "../../../src/shared/time";
import { LANG } from "./i18n";

export { DEFAULT_TIMEZONE, epochToZoned, formatTime, isValidTimeZone, zoneAbbr, zonedToEpoch, type SlotTime } from "../../../src/shared/time";

export const formatDate = (epochSec: number, tz: string): string => base.formatDate(epochSec, tz, LANG);
export const formatSlot = (slot: base.SlotTime, tz: string): string => base.formatSlot(slot, tz, LANG);
export const formatSlotTime = (slot: base.SlotTime, tz: string): string => base.formatSlotTime(slot, tz, LANG);
export const formatDateTime = (epochSec: number, tz: string): string => base.formatDateTime(epochSec, tz, LANG);
