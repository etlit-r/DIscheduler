import { describe, expect, it } from "vitest";
import { bestSlotId, effectiveStatus, tally } from "../src/shared/model";
import { isSafeChoiceText, sanitizeDisplayName, sanitizeLine } from "../src/shared/text";
import { epochToZoned, nextCronAt, zonedToEpoch } from "../src/shared/time";
import { canViewChannel } from "../src/discord/members";
import { escapeMarkdown } from "../src/discord/messages";

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
    expect(bestSlotId(slots, tally(slots, choices, answers))).toBe("b");
  });
  it("同じなら点数、次に日時が早い候補", () => {
    const answers = [
      { slotId: "a", userId: "1", choiceId: "maybe" },
      { slotId: "b", userId: "1", choiceId: "ok" },
    ];
    expect(bestSlotId(slots, tally(slots, choices, answers))).toBe("b");
    expect(bestSlotId(slots, tally(slots, choices, [{ slotId: "a", userId: "1", choiceId: "ok" }, { slotId: "b", userId: "1", choiceId: "ok" }]))).toBe("a");
  });
  it("誰も回答していなければ ★ なし", () => {
    expect(bestSlotId(slots, tally(slots, choices, []))).toBeNull();
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
