// 候補日時と選択肢の保存（Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { DAY, nowSec } from "../src/core/lib";
import { call, errorOf, jsonReq, login, mockDiscord, ORGANIZER, seedPoll, type DiscordCall } from "./helpers";

const db = () => (env as unknown as Env).DB;

let calls: DiscordCall[];
beforeEach(() => {
  calls = mockDiscord();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(opts: Parameters<typeof seedPoll>[0] = {}) {
  const s = await seedPoll(opts);
  const auth = await login(s.pollId, ORGANIZER, "organizer", "edit");
  const slotRows = async () =>
    (await db().prepare("SELECT id, start_at, end_at, all_day, position FROM slots WHERE poll_id = ? ORDER BY position").bind(s.pollId).all<{ id: string; start_at: number; end_at: number | null; all_day: number; position: number }>()).results;
  const choiceRows = async () =>
    (await db().prepare("SELECT id, symbol, label, kind, score, color, position FROM choices WHERE poll_id = ? ORDER BY position").bind(s.pollId).all<Record<string, unknown>>()).results;
  return {
    ...s,
    auth,
    slotRows,
    choiceRows,
    putSlots: (body: unknown) => call(jsonReq("PUT", `/api/polls/${s.pollId}/slots`, body, auth)),
    putChoices: (body: unknown) => call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, body, auth)),
  };
}

describe("候補日時の保存", () => {
  it("並べ替えて保存し、消した候補の回答も消す。終日の指定も保存する", async () => {
    const t = await setup({ status: "draft", messageId: null });
    const before = await t.slotRows();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(t.pollId, before[0]!.id, ORGANIZER, t.choiceIds[0], nowSec()).run();
    const base = nowSec() + 10 * DAY;
    const res = await t.putSlots({
      slots: [
        { id: before[2]!.id, startAt: base + 3600, endAt: base + 7200, allDay: true },
        { id: null, startAt: base, endAt: null, allDay: false },
        { id: before[1]!.id, startAt: base + 2 * 3600, endAt: null, allDay: false },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; updatedAt: number; warnings: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    const after = await t.slotRows();
    expect(after.map((s) => [s.start_at, s.end_at, s.all_day, s.position])).toEqual([
      [base, null, 0, 0],
      [base + 3600, base + 7200, 1, 1],
      [base + 7200, null, 0, 2],
    ]);
    expect(after[1]!.id).toBe(before[2]!.id);
    expect(after.some((s) => s.id === before[0]!.id)).toBe(false);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM answers WHERE poll_id = ?").bind(t.pollId).first<{ n: number }>();
    expect(n!.n).toBe(0);
    // 下書きでは募集メッセージを更新しない
    expect(calls).toHaveLength(0);
  });

  it("入力の検証", async () => {
    const t = await setup();
    const now = nowSec();
    const ids = (await t.slotRows()).map((s) => s.id);
    const msg = async (slots: unknown[], updatedAt?: number) => {
      const res = await t.putSlots(updatedAt === undefined ? { slots } : { slots, updatedAt });
      return res.status === 200 ? "ok" : (await errorOf(res)).message;
    };
    const s = (startAt: number, endAt: number | null = null, id: string | null = null) => ({ id, startAt, endAt, allDay: false });
    expect(await msg([s(now + DAY)], 1)).toContain("ほかの画面で変更されています");
    expect(await msg([s(now + DAY, null, "A".repeat(22))])).toContain("候補が見つかりません");
    expect(await msg([s(now + DAY, null, ids[0]!), s(now + 2 * DAY, null, ids[0]!), s(now + 3 * DAY, null, ids[1]!), s(now + 4 * DAY, null, ids[2]!)])).toContain("同じ候補が重複しています。画面");
    expect(await msg([s(now + DAY, now + DAY)])).toBe("終了は開始より後にしてください。");
    expect(await msg([s(now + DAY, now + DAY - 1)])).toBe("終了は開始より後にしてください。");
    expect(await msg([s(now - 366 * DAY - 60)])).toBe("候補の日時が範囲外です。");
    expect(await msg([s(now + 2 * 365 * DAY + 60)])).toBe("候補の日時が範囲外です。");
    expect(await msg([s(now + DAY, now + DAY + 60), s(now + DAY, now + DAY + 60)])).toBe("同じ候補が重複しています。");
    // 開始が同じでも終了が違えば別の候補
    expect(await msg([s(now + DAY, now + DAY + 60), s(now + DAY, now + DAY + 120), s(now - 366 * DAY + 60), s(now + 2 * 365 * DAY - 60)])).toBe("ok");
  });

  it("確定した候補は消せない", async () => {
    const t = await setup({ status: "fixed" });
    const rows = await t.slotRows();
    await db().prepare("UPDATE slots SET fixed_at = ? WHERE id = ?").bind(nowSec(), rows[1]!.id).run();
    const res = await t.putSlots({ slots: [{ id: rows[0]!.id, startAt: rows[0]!.start_at, endAt: rows[0]!.end_at, allDay: false }] });
    expect((await errorOf(res)).code).toBe("fixed_slot");
    const ok = await t.putSlots({ slots: [{ id: rows[1]!.id, startAt: rows[1]!.start_at, endAt: rows[1]!.end_at, allDay: false }] });
    expect(ok.status).toBe(200);
  });

  it("公開中なら募集メッセージを更新する", async () => {
    const t = await setup();
    const rows = await t.slotRows();
    await t.putSlots({ slots: rows.map((r) => ({ id: r.id, startAt: r.start_at, endAt: r.end_at, allDay: false })) });
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("確定した候補の終日の指定だけを変えても、Discord イベントを更新する。変えなければ更新しない", async () => {
    const t = await setup({ status: "fixed" });
    const rows = await t.slotRows();
    const start = nowSec() + 5 * DAY;
    await db().prepare("UPDATE slots SET fixed_at = ?, discord_event_id = 'ev1', start_at = ?, end_at = NULL WHERE id = ?").bind(nowSec(), start, rows[0]!.id).run();
    const others = rows.slice(1).map((r) => ({ id: r.id, startAt: r.start_at, endAt: r.end_at, allDay: false }));
    await t.putSlots({ slots: [{ id: rows[0]!.id, startAt: start, endAt: null, allDay: false }, ...others] });
    expect(calls.filter((c) => c.path.includes("scheduled-events"))).toHaveLength(0);
    await t.putSlots({ slots: [{ id: rows[0]!.id, startAt: start, endAt: null, allDay: true }, ...others] });
    expect(calls.filter((c) => c.path.includes("scheduled-events/ev1"))).toHaveLength(1);
  });
});

describe("選択肢の保存", () => {
  const ch = (symbol: string, label: string, kind: "ok" | "maybe" | "ng", id: string | null = null) => ({ id, symbol, label, kind, score: kind === "ok" ? 4 : kind === "maybe" ? 2 : 0, color: "green" });

  it("締切後・確定後は変えられない", async () => {
    for (const opts of [{ status: "closed" }, { status: "fixed" }, { deadlineAt: nowSec() - 60 }]) {
      const t = await setup(opts);
      const res = await t.putChoices({ choicesVersion: 1, choices: [ch("○", "a", "ok"), ch("×", "b", "ng")], reassign: [] });
      expect((await errorOf(res)).code).toBe("locked");
    }
  });

  it("版が違えば 409。参加できる・参加できないがそろっていなければ 400。名前の重複も 400", async () => {
    const t = await setup({ status: "draft", messageId: null });
    const put = async (choices: unknown[], choicesVersion = 1) => {
      const res = await t.putChoices({ choicesVersion, choices, reassign: [] });
      return res.status === 200 ? "ok" : (await errorOf(res)).message;
    };
    expect(await put([ch("○", "a", "ok"), ch("×", "b", "ng")], 2)).toContain("ほかの画面で変更されています");
    expect(await put([ch("○", "a", "ok"), ch("△", "b", "maybe")])).toContain("それぞれ 1 つ以上");
    expect(await put([ch("△", "a", "maybe"), ch("×", "b", "ng")])).toContain("それぞれ 1 つ以上");
    expect(await put([ch("○", "a", "ok"), ch("×", "a", "ng")])).toBe("選択肢の名前が重複しています。");
    expect(await put([ch("○", "a", "ok", "A".repeat(22)), ch("×", "b", "ng")])).toContain("選択肢が見つかりません");
    expect(await put([ch("○", "a", "ok", t.choiceIds[0]), ch("×", "b", "ng", t.choiceIds[0])])).toContain("同じ選択肢が重複しています");
  });

  it("送った順に並べ、版を 1 つ上げる。下書きでは変更の時刻を残さない", async () => {
    const t = await setup({ status: "draft", messageId: null });
    const res = await t.putChoices({ choicesVersion: 1, choices: [ch("×", "不可", "ng", t.choiceIds[2]), ch("◎", "ぜひ", "ok"), ch("○", "参加", "ok", t.choiceIds[0])], reassign: [] });
    expect(await res.json()).toEqual({ ok: true, choicesVersion: 2 });
    expect((await t.choiceRows()).map((c) => [c.symbol, c.label, c.position])).toEqual([
      ["×", "不可", 0],
      ["◎", "ぜひ", 1],
      ["○", "参加", 2],
    ]);
    const p = await db().prepare("SELECT choices_version, choices_changed_at FROM polls WHERE id = ?").bind(t.pollId).first();
    expect(p).toEqual({ choices_version: 2, choices_changed_at: null });
    expect(calls).toHaveLength(0);
  });

  it("回答がある選択肢を消すときは、残す選択肢に移す", async () => {
    const t = await setup();
    const [ok, maybe, ng] = t.choiceIds as [string, string, string];
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, prev_choice_id, updated_at) VALUES (?, ?, ?, ?, ?, 1)").bind(t.pollId, t.slotIds[0], ORGANIZER, maybe, maybe).run();
    const base = { choicesVersion: 1, choices: [ch("○", "参加", "ok", ok), ch("×", "不可", "ng", ng)] };
    expect((await errorOf(await t.putChoices({ ...base, reassign: [] }))).code).toBe("reassign_required");
    // 移し先が消える選択肢なら受け付けない
    expect((await errorOf(await t.putChoices({ ...base, reassign: [{ from: maybe, to: maybe }] }))).code).toBe("reassign_required");
    const res = await t.putChoices({ ...base, reassign: [{ from: maybe, to: ok }] });
    expect(res.status).toBe(200);
    const a = await db().prepare("SELECT choice_id, prev_choice_id, updated_at FROM answers WHERE poll_id = ?").bind(t.pollId).first<{ choice_id: string; prev_choice_id: string | null; updated_at: number }>();
    expect(a!.choice_id).toBe(ok);
    expect(a!.prev_choice_id).toBeNull();
    expect(a!.updated_at).toBeGreaterThan(1);
    const p = await db().prepare("SELECT choices_changed_at FROM polls WHERE id = ?").bind(t.pollId).first<{ choices_changed_at: number | null }>();
    expect(p!.choices_changed_at).not.toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("回答のない選択肢は、移し先なしで消せる", async () => {
    const t = await setup();
    const [ok, , ng] = t.choiceIds as [string, string, string];
    const res = await t.putChoices({ choicesVersion: 1, choices: [ch("○", "参加", "ok", ok), ch("×", "不可", "ng", ng)], reassign: [] });
    expect(res.status).toBe(200);
    expect(await t.choiceRows()).toHaveLength(2);
  });
});
