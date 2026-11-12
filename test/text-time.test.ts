// 文字列と日時の小さな関数の境界を確かめる（Stryker で検出できなかったミュータントへの対策）
import { describe, expect, it } from "vitest";
import {
  charLength,
  donationNote,
  graphemeLength,
  hasControlChars,
  hasControlCharsExceptNewline,
  isSafeChoiceText,
  isValidDonationUrl,
  KOFI_DONATION_NOTE,
  sanitizeDisplayName,
  sanitizeLine,
} from "../src/shared/text";
import { epochToZoned, formatDate, formatDateTime, formatSlot, formatTime, isValidTimeZone, nextCronAt, zonedToEpoch, zoneAbbr, zoneOffsetMs } from "../src/shared/time";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("寄付リンクの URL", () => {
  it("https のドメインと、決まった文字のパスだけを受け付ける", () => {
    expect(isValidDonationUrl("https://ko-fi.com")).toBe(true);
    expect(isValidDonationUrl("https://ko-fi.com/")).toBe(true);
    expect(isValidDonationUrl("https://ko-fi.com/a_b.c~d/e-f")).toBe(true);
    expect(isValidDonationUrl("https://a.b")).toBe(true);
  });
  it("それ以外は受け付けない", () => {
    for (const u of [
      "http://ko-fi.com/x",
      " https://ko-fi.com/x",
      "xhttps://ko-fi.com/x",
      "https://ko-fi.com/x\"onload=",
      "https://ko-fi.com/x?y=1",
      "https://ko-fi.com/<x>",
      "https:///x",
      "https://",
      "https://ko_fi.com",
      "https://ko-fi.com:443",
    ]) {
      expect(isValidDonationUrl(u), u).toBe(false);
    }
    expect(isValidDonationUrl(null)).toBe(false);
    expect(isValidDonationUrl(undefined)).toBe(false);
  });
  it("Ko-fi かどうかはドメインの区切りまで見る", () => {
    expect(donationNote("https://ko-fi.com")).toBe(KOFI_DONATION_NOTE);
    expect(donationNote("http://ko-fi.com/x")).toBe("");
    expect(donationNote("https://xko-fi.com/x")).toBe("");
    expect(donationNote("https://ko-fixcom/x")).toBe("");
    expect(donationNote("https://wwwxko-fi.com/x")).toBe("");
    expect(donationNote("x https://ko-fi.com/x")).toBe("");
  });
});

describe("制御文字", () => {
  it("制御文字・見えない書式文字を見つける", () => {
    expect(hasControlChars("abc")).toBe(false);
    expect(hasControlChars("a\nb")).toBe(true);
    expect(hasControlChars("a\u0000")).toBe(true);
    expect(hasControlChars("a\u001f")).toBe(true);
    expect(hasControlChars("a\u007f")).toBe(true);
    expect(hasControlChars("a\u009f")).toBe(true);
    expect(hasControlChars("a ")).toBe(false);
    expect(hasControlChars("a​")).toBe(true);
    expect(hasControlChars("a‮")).toBe(true);
    expect(hasControlChars("a﻿")).toBe(true);
  });
  it("説明欄では改行（\\n と \\r\\n）だけを許す", () => {
    expect(hasControlCharsExceptNewline("a\nb\r\nc")).toBe(false);
    expect(hasControlCharsExceptNewline("a\rb")).toBe(true);
    expect(hasControlCharsExceptNewline("a\tb")).toBe(true);
    expect(hasControlCharsExceptNewline("a​\nb")).toBe(true);
  });
  it("選択肢の文字は、記法に使う記号と制御文字を拒否する", () => {
    for (const s of ["<", ">", "@", "`", "\\", "a\u0000", "a​"]) expect(isSafeChoiceText(s), s).toBe(false);
    expect(isSafeChoiceText("△ 未定")).toBe(true);
  });
});

describe("長さの切り詰め", () => {
  it("ちょうど上限なら切らず、超えたら切って末尾の空白を落とす", () => {
    expect(sanitizeLine("abc", 3)).toBe("abc");
    expect(sanitizeLine("ab c", 3)).toBe("ab");
    expect(sanitizeLine("abcd", 3)).toBe("abc");
    expect(sanitizeLine("😀😀😀", 2)).toBe("😀😀");
  });
  it("NFC に正規化する", () => {
    expect(sanitizeLine("が", 10)).toBe("が");
  });
  it("表示名の長さの上限を指定できる", () => {
    expect(sanitizeDisplayName("abcdef", 3)).toBe("abc");
    expect(sanitizeDisplayName("  ")).toBe("（名前なし）");
    expect(sanitizeDisplayName("a")).toBe("a");
  });
  it("書記素とコードポイントで数える", () => {
    expect(graphemeLength("👨‍👩‍👧")).toBe(1);
    expect(graphemeLength("abc")).toBe(3);
    expect(graphemeLength("")).toBe(0);
    expect(charLength("😀a")).toBe(2);
  });
});

describe("タイムゾーン", () => {
  it("使えるタイムゾーンだけを受け付ける", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("x".repeat(65))).toBe(false);
    expect(isValidTimeZone(123 as unknown as string)).toBe(false);
  });
  it("オフセットを求める", () => {
    expect(zoneOffsetMs(Date.UTC(2026, 0, 1), "Asia/Tokyo")).toBe(9 * 3600 * 1000);
    expect(zoneOffsetMs(Date.UTC(2026, 0, 1), "America/New_York")).toBe(-5 * 3600 * 1000);
    // ミリ秒の端数は切り捨てて比べる
    expect(zoneOffsetMs(Date.UTC(2026, 0, 1) + 999, "UTC")).toBe(0);
  });
  it("真夜中は 0 時として扱う", () => {
    expect(epochToZoned(at("2026-11-11T15:00:00Z"), "Asia/Tokyo")).toEqual({ year: 2026, month: 11, day: 12, hour: 0, minute: 0, second: 0 });
  });
  it("夏時間の切り替わりをまたいでも壁時計の時刻に合わせる", () => {
    // 2026-03-08 はニューヨークの夏時間の開始日。前日の推測オフセット（-5h）から -4h に補正される
    expect(zonedToEpoch(2026, 3, 8, 12, 0, "America/New_York")).toBe(at("2026-03-08T16:00:00Z"));
    expect(zonedToEpoch(2026, 3, 8, 0, 30, "America/New_York")).toBe(at("2026-03-08T05:30:00Z"));
    expect(zonedToEpoch(2026, 11, 1, 12, 0, "America/New_York")).toBe(at("2026-11-01T17:00:00Z"));
  });
});

describe("日時の表示", () => {
  const tz = "Asia/Tokyo";
  const t = at("2026-11-12T11:05:00Z"); // 11/12(木) 20:05 JST
  it("日付・時刻・日時", () => {
    expect(formatDate(t, tz)).toBe("11/12(木)");
    expect(formatDate(at("2026-11-14T15:00:00Z"), tz)).toBe("11/15(日)");
    expect(formatDate(at("2026-11-13T15:00:00Z"), tz)).toBe("11/14(土)");
    expect(formatTime(t, tz)).toBe("20:05");
    expect(formatTime(at("2026-11-11T15:00:00Z"), tz)).toBe("00:00");
    expect(formatDateTime(t, tz)).toBe("11/12(木) 20:05");
  });
  it("候補の表示（終日・終わりなし・同じ日・日をまたぐ）", () => {
    expect(formatSlot({ startAt: t, endAt: null, allDay: true }, tz)).toBe("11/12(木) 終日");
    expect(formatSlot({ startAt: t, endAt: null, allDay: false }, tz)).toBe("11/12(木) 20:05〜");
    expect(formatSlot({ startAt: t, endAt: t + 7200, allDay: false }, tz)).toBe("11/12(木) 20:05–22:05");
    expect(formatSlot({ startAt: t, endAt: t + 6 * 3600, allDay: false }, tz)).toBe("11/12(木) 20:05–11/13(金) 02:05");
  });
  it("タイムゾーンの略称", () => {
    expect(zoneAbbr(t, "Asia/Tokyo")).toBe("JST");
    expect(zoneAbbr(t, "UTC")).toBe("UTC");
    expect(zoneAbbr(at("2026-07-01T00:00:00Z"), "America/New_York")).toBe("EDT");
  });
  it("次の自動更新は、ちょうどその時刻なら次の回", () => {
    expect(nextCronAt(at("2026-11-06T04:00:00Z"))).toBe(at("2026-11-06T16:00:00Z"));
    expect(nextCronAt(at("2026-11-06T03:59:59Z"))).toBe(at("2026-11-06T04:00:00Z"));
    expect(nextCronAt(at("2026-11-06T16:00:00Z"))).toBe(at("2026-11-07T04:00:00Z"));
    expect(nextCronAt(at("2026-11-06T00:00:00Z"))).toBe(at("2026-11-06T04:00:00Z"));
  });
});
