import { langFromAcceptLanguage, langFromTag } from "../src/shared/i18n";
import { describe, expect, it } from "vitest";
import { bestSlotIds, effectiveStatus, tally } from "../src/shared/model";
import { donationNote, isSafeChoiceText, KOFI_DONATION_NOTE, sanitizeDisplayName, sanitizeLine } from "../src/shared/text";
import { epochToZoned, formatSlot, formatSlotTime, nextCronAt, zonedToEpoch } from "../src/shared/time";
import { canViewChannel } from "../src/discord/members";
import { buildDayReminderMessage, buildDeletedMessage, buildFixedMessage, buildPollMessage, escapeMarkdown, pickShownSlots } from "../src/discord/messages";

describe("集計と最有力候補（§6.9.3）", () => {
  const choices = [
    { id: "ok", kind: "ok" as const, score: 2 },
    { id: "maybe", kind: "maybe" as const, score: 1 },
    { id: "ng", kind: "ng" as const, score: 0 },
  ];
  const slots = [
    { id: "a", startAt: 100 },
    { id: "b", startAt: 200 },
  ];
  it("「参加できない」が少ない候補を優先する", () => {
    const answers = [
      { slotId: "a", userId: "1", choiceId: "ok" },
      { slotId: "a", userId: "2", choiceId: "ng" },
      { slotId: "b", userId: "1", choiceId: "maybe" },
      { slotId: "b", userId: "2", choiceId: "maybe" },
    ];
    expect([...bestSlotIds(slots, tally(slots, choices, answers))]).toEqual(["b"]);
  });
  it("同じなら点数で比べ、成績が同じ候補にはすべて付ける", () => {
    const answers = [
      { slotId: "a", userId: "1", choiceId: "maybe" },
      { slotId: "b", userId: "1", choiceId: "ok" },
    ];
    expect([...bestSlotIds(slots, tally(slots, choices, answers))]).toEqual(["b"]);
    expect([...bestSlotIds(slots, tally(slots, choices, [{ slotId: "a", userId: "1", choiceId: "ok" }, { slotId: "b", userId: "1", choiceId: "ok" }]))]).toEqual(["a", "b"]);
  });
  it("いちばん良い候補が 4 件以上並んだら（全部同じなど）★ なし", () => {
    const four = ["a", "b", "c", "d"].map((id, i) => ({ id, startAt: i }));
    const ng = (ids: string[]) => ids.map((slotId) => ({ slotId, userId: "1", choiceId: "ng" }));
    expect(bestSlotIds(four, tally(four, choices, ng(["a", "b", "c", "d"]))).size).toBe(0);
    expect([...bestSlotIds(four, tally(four, choices, ng(["a", "b", "c", "d"]).map((x) => (x.slotId === "d" ? { ...x, choiceId: "ok" } : x))))]).toEqual(["d"]);
    expect([...bestSlotIds(four, tally(four, choices, ng(["a", "b", "c"]).concat([{ slotId: "d", userId: "1", choiceId: "ok" }])))]).toEqual(["d"]);
    // 3 件までの同点なら付ける
    expect(bestSlotIds(four, tally(four, choices, ng(["d"]).concat(["a", "b", "c"].map((slotId) => ({ slotId, userId: "1", choiceId: "ok" }))))).size).toBe(3);
  });
  it("誰も回答していなければ ★ なし", () => {
    expect(bestSlotIds(slots, tally(slots, choices, [])).size).toBe(0);
  });
  it("締切を過ぎたら closed として扱う", () => {
    expect(effectiveStatus("open", 100, 200)).toBe("closed");
    expect(effectiveStatus("fixed", 100, 200)).toBe("fixed");
  });
});

describe("タイムゾーン（§6.7）", () => {
  it("壁時計の日時と UNIX 秒を相互に変換できる", () => {
    const ep = zonedToEpoch(2026, 11, 12, 20, 0, "Asia/Tokyo");
    expect(ep).toBe(Date.UTC(2026, 10, 12, 11, 0) / 1000);
    expect(epochToZoned(ep, "Asia/Tokyo")).toMatchObject({ year: 2026, month: 11, day: 12, hour: 20, minute: 0 });
    const ny = zonedToEpoch(2026, 7, 1, 9, 30, "America/New_York");
    expect(ny).toBe(Date.UTC(2026, 6, 1, 13, 30) / 1000);
  });
  it("次の自動更新は日本時間 1 時か 13 時", () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    expect(nextCronAt(at("2026-11-06T03:00:00Z"))).toBe(at("2026-11-06T04:00:00Z"));
    expect(nextCronAt(at("2026-11-06T05:00:00Z"))).toBe(at("2026-11-06T16:00:00Z"));
    expect(nextCronAt(at("2026-11-06T17:00:00Z"))).toBe(at("2026-11-07T04:00:00Z"));
  });
});

describe("文字列の検証（security-design §4.4）", () => {
  it("表示名から制御文字・双方向制御文字を取り除き、長さを切り詰める", () => {
    expect(sanitizeDisplayName("abc‮def\n")).toBe("abcdef");
    expect(Array.from(sanitizeDisplayName("あ".repeat(100))).length).toBe(64);
    expect(sanitizeDisplayName("​")).toBe("（名前なし）");
  });
  it("空白や見えない文字だけのタイトルは空になる", () => {
    expect(sanitizeLine("  \u200b ", 100)).toBe("");
    expect(sanitizeLine(" 定例会 ", 100)).toBe("定例会");
  });
  it("選択肢にメンション・カスタム絵文字の記法は使えない", () => {
    expect(isSafeChoiceText("○")).toBe(true);
    expect(isSafeChoiceText("<:x:1>")).toBe(false);
    expect(isSafeChoiceText("@everyone")).toBe(false);
  });
  it("Discord の Markdown をエスケープする", () => {
    expect(escapeMarkdown("**太字** @everyone <@1>")).toBe("\\*\\*太字\\*\\* \\@everyone \\<\\@1\\>");
  });
});

describe("チャンネルの閲覧権限の計算（§5.3）", () => {
  const roles = new Map([
    ["g", { id: "g", name: "@everyone", permissions: String(1n << 10n), position: 0 }],
    ["r", { id: "r", name: "member", permissions: "0", position: 1 }],
  ]);
  const ch = (overwrites: { id: string; type: 0 | 1; allow: string; deny: string }[]) => ({ id: "c", type: 0, permission_overwrites: overwrites });
  const m = (id: string, rs: string[] = []) => ({ user: { id, username: id }, roles: rs });
  it("@everyone の拒否とロールの許可", () => {
    const c = ch([
      { id: "g", type: 0, allow: "0", deny: String(1n << 10n) },
      { id: "r", type: 0, allow: String(1n << 10n), deny: "0" },
    ]);
    expect(canViewChannel(m("1"), "g", "owner", roles, c)).toBe(false);
    expect(canViewChannel(m("2", ["r"]), "g", "owner", roles, c)).toBe(true);
    expect(canViewChannel(m("owner"), "g", "owner", roles, c)).toBe(true);
  });
  it("メンバー個別の拒否が最優先", () => {
    const c = ch([{ id: "3", type: 1, allow: "0", deny: String(1n << 10n) }]);
    expect(canViewChannel(m("3"), "g", "owner", roles, c)).toBe(false);
    expect(canViewChannel(m("4"), "g", "owner", roles, c)).toBe(true);
  });
});

describe("ログにトークンを残さない（security-design I-4）", () => {
  it("Discord のエラー文から Interaction トークンを伏せる", async () => {
    const { DiscordError, redactPath } = await import("../src/discord/rest");
    const e = new DiscordError(500, "", "/webhooks/100000000000000001/aW50ZXJhY3Rpb246c2VjcmV0/messages/@original");
    expect(e.message).not.toContain("aW50ZXJhY3Rpb246c2VjcmV0");
    expect(e.message).toContain("/webhooks/100000000000000001/[redacted]/messages/@original");
    expect(redactPath("/channels/1/messages/2")).toBe("/channels/1/messages/2");
  });
});

describe("寄付リンクの説明（§6.10）", () => {
  it("Ko-fi のときだけ日本語の説明を返す", () => {
    expect(donationNote("https://ko-fi.com/example")).toBe(KOFI_DONATION_NOTE);
    expect(donationNote("https://www.ko-fi.com/example")).toBe(KOFI_DONATION_NOTE);
    expect(donationNote("https://github.com/sponsors/example")).toBe("");
    expect(donationNote("https://ko-fi.com.example.com/x")).toBe("");
  });
});

describe("formatSlotTime（日付を見出しにまとめるときの時間帯）", () => {
  const tz = "Asia/Tokyo";
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => zonedToEpoch(y, mo, d, h, mi, tz);
  it("日付を除いた時間帯を返す", () => {
    expect(formatSlot({ startAt: at(2026, 11, 12, 20), endAt: at(2026, 11, 12, 22), allDay: false }, tz)).toBe("11/12(木) 20:00–22:00");
    expect(formatSlotTime({ startAt: at(2026, 11, 12, 20), endAt: at(2026, 11, 12, 22), allDay: false }, tz)).toBe("20:00–22:00");
    expect(formatSlotTime({ startAt: at(2026, 11, 12, 20), endAt: null, allDay: false }, tz)).toBe("20:00〜");
    expect(formatSlotTime({ startAt: at(2026, 11, 12, 0), endAt: null, allDay: true }, tz)).toBe("終日");
  });
  it("日付をまたぐ候補は、終わりの日付を残す", () => {
    expect(formatSlotTime({ startAt: at(2026, 11, 12, 23), endAt: at(2026, 11, 13, 1), allDay: false }, tz)).toBe("23:00–11/13(金) 01:00");
  });
});

describe("言語（§6.12）", () => {
  it("日本語のタグだけ日本語、ほかは英語", () => {
    expect(langFromTag("ja")).toBe("ja");
    expect(langFromTag("ja-JP")).toBe("ja");
    expect(langFromTag("en-US")).toBe("en");
    expect(langFromTag("fr")).toBe("en");
    expect(langFromTag("jam")).toBe("en");
  });
  it("Accept-Language は優先度の高い言語で決め、なければ日本語", () => {
    expect(langFromAcceptLanguage("en-US,en;q=0.9,ja;q=0.8")).toBe("en");
    expect(langFromAcceptLanguage("de;q=0.5, ja")).toBe("ja");
    expect(langFromAcceptLanguage(null)).toBe("ja");
  });
  it("英語の日時の書式", () => {
    const at = Date.UTC(2026, 10, 18, 11) / 1000; // 2026-11-18 20:00 JST
    expect(formatSlot({ startAt: at, endAt: at + 7200, allDay: false }, "Asia/Tokyo", "en")).toBe("Wed, Nov 18 20:00–22:00");
    expect(formatSlot({ startAt: at, endAt: null, allDay: true }, "Asia/Tokyo", "en")).toBe("Wed, Nov 18 All day");
  });
});

describe("チャンネルに投稿するメッセージの言語（§6.12）", () => {
  const poll = {
    id: "AAAAAAAAAAAAAAAAAAAAAA", guild_id: "1", channel_id: "2", message_id: "3", organizer_id: "4", title: null, description: null,
    timezone: "Asia/Tokyo", timezone_set: 1, target_type: "channel", target_id: null, join_policy: "closed", status: "open",
    deadline_at: 1900000000, choices_version: 1, lang: "en",
  } as unknown as Parameters<typeof buildPollMessage>[0]["poll"];
  it("英語の調整は、募集メッセージ・削除・お知らせ・リマインドを英語で書く", () => {
    const m = buildPollMessage({ poll, slots: [], choices: [], participants: [], answers: [], now: 1800000000 });
    const text = JSON.stringify(m);
    expect(text).toContain("Scheduling poll");
    expect(text).toContain("Deadline:");
    expect(text).toContain('"label":"Answer"');
    expect(text).not.toMatch(/[ぁ-ん]/);
    expect(JSON.stringify(buildDeletedMessage(poll))).not.toMatch(/[ぁ-ん]/);
    expect(JSON.stringify(buildFixedMessage(poll, [{ when: "<t:1:F>", note: null }], [], true))).not.toMatch(/[ぁ-ん]/);
    expect(JSON.stringify(buildDayReminderMessage(poll, { startAt: 1900000000, allDay: true, timezone: "Asia/Tokyo" }))).toContain("(all day)");
  });
  it("日本語の調整は、これまでどおり日本語で書く", () => {
    const text = JSON.stringify(buildPollMessage({ poll: { ...poll, lang: "ja" }, slots: [], choices: [], participants: [], answers: [], now: 1800000000 }));
    expect(text).toContain("日程調整");
    expect(text).toContain('"label":"回答する"');
  });
});

describe("募集メッセージの候補の省略（§5.5）", () => {
  const poll = {
    id: "AAAAAAAAAAAAAAAAAAAAAA", guild_id: "1", channel_id: "2", message_id: "3", organizer_id: "4", title: "t", description: null,
    timezone: "Asia/Tokyo", timezone_set: 1, target_type: "channel", target_id: null, join_policy: "open", status: "open",
    deadline_at: 1900000000, choices_version: 1, lang: "ja",
  } as unknown as Parameters<typeof buildPollMessage>[0]["poll"];
  const slot = (i: number, fixed = false) => ({ id: `s${i}`, poll_id: poll.id, start_at: 1900000000 + i * 86400, end_at: null, all_day: 1, position: i, fixed_at: fixed ? 1 : null, discord_event_id: null, announced_fixed: 0, day_reminded_at: null });
  const choices = [
    { id: "ok", poll_id: poll.id, symbol: "○", label: "参加", kind: "ok", score: 2, color: "green", position: 0 },
    { id: "ng", poll_id: poll.id, symbol: "×", label: "不可", kind: "ng", score: 0, color: "red", position: 1 },
  ];
  const lineCount = (n: number) => {
    const slots = Array.from({ length: n }, (_, i) => slot(i));
    const desc = buildPollMessage({ poll, slots, choices, participants: [], answers: [], now: 1800000000 } as unknown as Parameters<typeof buildPollMessage>[0]).embeds[0]!.description;
    return { lines: desc.split("\n").filter((l) => l.includes("<t:") && l.includes("人")).length, desc };
  };
  it("4 件まではすべて出し、5 件以上は 4 件と残りの件数を出す", () => {
    expect(lineCount(4).lines).toBe(4);
    expect(lineCount(4).desc).not.toContain("ほか");
    expect(lineCount(5).lines).toBe(4);
    expect(lineCount(5).desc).toContain("ほか 1 件");
    expect(lineCount(16).desc).toContain("ほか 12 件");
  });
  it("確定した候補と、成績の良い候補（★と同じ比べ方）を優先し、日時順に並べる", () => {
    const slots = Array.from({ length: 8 }, (_, i) => slot(i, i === 7));
    const s = slots.map((x) => ({ id: x.id, startAt: x.start_at }));
    const ans = (slotId: string, userId: string, choiceId: string) => ({ slotId, userId, choiceId });
    // s1 は ○1 ×0（★）。s2〜s5 は ○2 ×2（「参加できる」は多いが、×も多い）
    const answers = [ans("s1", "a", "ok"), ...["s2", "s3", "s4", "s5"].flatMap((id) => [ans(id, "a", "ok"), ans(id, "b", "ok"), ans(id, "c", "ng"), ans(id, "d", "ng")])];
    const tl = tally(s, choices as never, answers);
    expect(pickShownSlots(slots, tl, bestSlotIds(s, tl)).map((x) => x.id)).toEqual(["s1", "s2", "s3", "s7"]);
  });
  it("確定した候補と★の候補を合わせて 4 件より多ければ、それらをすべて出す", () => {
    const slots = Array.from({ length: 8 }, (_, i) => slot(i, i >= 6));
    const s = slots.map((x) => ({ id: x.id, startAt: x.start_at }));
    // s0〜s2 が同じ成績で★（3 件）。s6・s7 は確定
    const tl = tally(s, choices as never, ["s0", "s1", "s2"].map((slotId) => ({ slotId, userId: "a", choiceId: "ok" })).concat([{ slotId: "s3", userId: "a", choiceId: "ng" }]));
    expect(pickShownSlots(slots, tl, bestSlotIds(s, tl)).map((x) => x.id)).toEqual(["s0", "s1", "s2", "s6", "s7"]);
  });
});
