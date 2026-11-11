// 集計・状態・リマインド時刻とひな形（Stryker で検出できなかったミュータントへの対策）
import { describe, expect, it } from "vitest";
import {
  bestSlotId,
  canAnswer,
  CHOICE_COLORS,
  CHOICE_KINDS,
  CHOICE_TEMPLATES,
  compareSlots,
  DEFAULT_COLOR,
  DEFAULT_REMIND,
  DEFAULT_SCORE,
  effectiveStatus,
  KIND_LABEL,
  LIMITS,
  reminderAt,
  tally,
  UNANSWERED,
} from "../src/shared/model";
import { graphemeLength, isSafeChoiceText } from "../src/shared/text";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("ひな形と定数", () => {
  it("ひな形の ID・名前は一意で、先頭が標準", () => {
    expect(CHOICE_TEMPLATES.map((t) => t.id)).toEqual(["standard", "binary", "four", "time"]);
    expect(new Set(CHOICE_TEMPLATES.map((t) => t.name)).size).toBe(CHOICE_TEMPLATES.length);
    expect(CHOICE_TEMPLATES[0]!.choices.map((c) => c.symbol)).toEqual(["○", "△", "×"]);
  });
  it("どのひな形も入力の検証を通る（記号・名前・点数・色・種類）", () => {
    for (const t of CHOICE_TEMPLATES) {
      expect(t.name.length, t.id).toBeGreaterThan(0);
      expect(t.choices.length).toBeGreaterThanOrEqual(LIMITS.choicesMin);
      expect(t.choices.length).toBeLessThanOrEqual(LIMITS.choicesMax);
      expect(new Set(t.choices.map((c) => c.symbol)).size, t.id).toBe(t.choices.length);
      expect(new Set(t.choices.map((c) => c.label)).size, t.id).toBe(t.choices.length);
      expect(t.choices.some((c) => c.kind === "ok"), t.id).toBe(true);
      expect(t.choices.some((c) => c.kind === "ng"), t.id).toBe(true);
      for (const c of t.choices) {
        expect(graphemeLength(c.symbol)).toBeGreaterThanOrEqual(1);
        expect(graphemeLength(c.symbol)).toBeLessThanOrEqual(LIMITS.choiceSymbolGraphemesMax);
        expect(c.label.length).toBeGreaterThan(0);
        expect(c.label.length).toBeLessThanOrEqual(LIMITS.choiceLabelMax);
        expect(isSafeChoiceText(c.symbol) && isSafeChoiceText(c.label)).toBe(true);
        expect(CHOICE_COLORS).toContain(c.color);
        expect(CHOICE_KINDS).toContain(c.kind);
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(LIMITS.choiceScoreMax);
        // 「参加できない」は 0 点、それ以外は 0 点より上
        expect(c.score === 0).toBe(c.kind === "ng");
      }
      // 点数は上から順に下がる
      const scores = t.choices.map((c) => c.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
  });
  it("種類ごとの既定値", () => {
    expect(CHOICE_KINDS).toEqual(["ok", "maybe", "ng"]);
    expect(CHOICE_COLORS).toEqual(["green", "teal", "yellow", "orange", "red", "gray"]);
    expect(KIND_LABEL).toEqual({ ok: "参加できる", maybe: "未定", ng: "参加できない" });
    expect(DEFAULT_SCORE).toEqual({ ok: 4, maybe: 2, ng: 0 });
    expect(DEFAULT_COLOR).toEqual({ ok: "green", maybe: "yellow", ng: "red" });
    expect(DEFAULT_REMIND).toEqual({ dayOffset: 0, hour: 17 });
    expect(UNANSWERED).toBe("");
    expect(LIMITS.bodyBytesMax).toBe(32768);
  });
});

describe("集計", () => {
  const choices = [
    { id: "ok", kind: "ok" as const, score: 4 },
    { id: "maybe", kind: "maybe" as const, score: 2 },
    { id: "ng", kind: "ng" as const, score: 0 },
  ];
  const slots = [
    { id: "a", startAt: 100 },
    { id: "b", startAt: 200 },
  ];
  it("選択肢ごと・種類ごとに数え、知らない候補・選択肢の回答は無視する", () => {
    const t = tally(slots, choices, [
      { slotId: "a", userId: "1", choiceId: "ok" },
      { slotId: "a", userId: "2", choiceId: "ok" },
      { slotId: "a", userId: "3", choiceId: "maybe" },
      { slotId: "a", userId: "4", choiceId: "ng" },
      { slotId: "x", userId: "1", choiceId: "ok" },
      { slotId: "b", userId: "1", choiceId: "x" },
    ]);
    expect(t.get("a")).toEqual({ slotId: "a", byChoice: { ok: 2, maybe: 1, ng: 1 }, ok: 2, maybe: 1, ng: 1, answered: 4, score: 10 });
    expect(t.get("b")).toEqual({ slotId: "b", byChoice: { ok: 0, maybe: 0, ng: 0 }, ok: 0, maybe: 0, ng: 0, answered: 0, score: 0 });
    expect(t.has("x")).toBe(false);
  });
  it("比較の順: 参加できないが少ない → 点数 → 参加できるが多い → 日時が早い", () => {
    const base = { slotId: "", byChoice: {}, maybe: 0, answered: 1 };
    const A = { id: "a", startAt: 100 };
    const B = { id: "b", startAt: 200 };
    expect(compareSlots(A, { ...base, ng: 1, ok: 9, score: 99 }, B, { ...base, ng: 0, ok: 0, score: 0 })).toBe(1);
    expect(compareSlots(A, { ...base, ng: 0, ok: 0, score: 3 }, B, { ...base, ng: 0, ok: 9, score: 5 })).toBe(2);
    expect(compareSlots(A, { ...base, ng: 0, ok: 1, score: 4 }, B, { ...base, ng: 0, ok: 2, score: 4 })).toBe(1);
    expect(compareSlots(A, { ...base, ng: 0, ok: 1, score: 4 }, B, { ...base, ng: 0, ok: 1, score: 4 })).toBe(-100);
  });
  it("点数が同じなら「参加できる」が多い候補が ★", () => {
    const four = [
      { id: "ok", kind: "ok" as const, score: 4 },
      { id: "m4", kind: "maybe" as const, score: 4 },
    ];
    const ans = [
      { slotId: "a", userId: "1", choiceId: "m4" },
      { slotId: "b", userId: "1", choiceId: "ok" },
    ];
    expect(bestSlotId(slots, tally(slots, four, ans))).toBe("b");
  });
  it("回答のない候補は ★ にならない", () => {
    const ans = [{ slotId: "b", userId: "1", choiceId: "ng" }];
    expect(bestSlotId(slots, tally(slots, choices, ans))).toBe("b");
    expect(bestSlotId(slots, new Map())).toBeNull();
  });
});

describe("状態", () => {
  it("締切ちょうどで締め切る。締切なしは締め切らない", () => {
    expect(effectiveStatus("open", 200, 199)).toBe("open");
    expect(effectiveStatus("open", 200, 200)).toBe("closed");
    expect(effectiveStatus("open", null, 10 ** 12)).toBe("open");
    expect(effectiveStatus("draft", 100, 200)).toBe("draft");
  });
  it("回答できる状態", () => {
    expect(["draft", "open", "closed", "fixed", "cancelled"].map((s) => canAnswer(s as "open"))).toEqual([false, true, true, true, false]);
  });
});

describe("予定のリマインドの時刻", () => {
  const tz = "Asia/Tokyo";
  const start = at("2026-11-20T11:00:00Z"); // 11/20 20:00 JST
  it("当日・前日の指定の時刻", () => {
    expect(reminderAt({ startAt: start, allDay: false }, tz, 0, 17)).toBe(at("2026-11-20T08:00:00Z"));
    expect(reminderAt({ startAt: start, allDay: false }, tz, 1, 9)).toBe(at("2026-11-19T00:00:00Z"));
    // 月をまたぐ
    expect(reminderAt({ startAt: at("2026-12-01T11:00:00Z"), allDay: false }, tz, 1, 20)).toBe(at("2026-11-30T11:00:00Z"));
  });
  it("予定の開始ちょうど以降なら送らない", () => {
    expect(reminderAt({ startAt: start, allDay: false }, tz, 0, 20)).toBeNull();
    expect(reminderAt({ startAt: start, allDay: false }, tz, 0, 21)).toBeNull();
    expect(reminderAt({ startAt: start, allDay: false }, tz, 0, 19)).toBe(at("2026-11-20T10:00:00Z"));
  });
  it("終日の予定は、その日が終わるまでなら送る", () => {
    const day = at("2026-11-19T15:00:00Z"); // 11/20 0:00 JST
    expect(reminderAt({ startAt: day, allDay: true }, tz, 0, 23)).toBe(at("2026-11-20T14:00:00Z"));
    expect(reminderAt({ startAt: day, allDay: false }, tz, 0, 23)).toBeNull();
    expect(reminderAt({ startAt: day, allDay: true }, tz, -1, 0)).toBeNull();
  });
});
