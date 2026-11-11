import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { runCron } from "../src/jobs/cron";
import { DAY_REMINDER_MAX_PER_RUN, reminderWindow } from "../src/jobs/day-reminder";
import { CHANNEL, mockDiscord, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());
// ほかのテストで作った確定済みの調整が、範囲に入って送られないようにする
beforeEach(async () => {
  await db().prepare("DELETE FROM polls").run();
});

/** 日本時間 2026-11-06 10:00 と 17:00 の Cron */
const AT_10 = Date.parse("2026-11-06T01:00:00Z");
const AT_17 = Date.parse("2026-11-06T08:00:00Z");
/** 日本時間の日時（"2026-11-06T18:00"）を UNIX 秒にする */
const jst = (local: string) => Math.floor(Date.parse(`${local}:00+09:00`) / 1000);

/** 確定済みの調整を作り、確定した候補の開始時刻を startAt にする */
async function fixedPoll(startAt: number, opts: { allDay?: boolean; role?: string; messageId?: string | null } = {}) {
  const s = await seedPoll({ status: "fixed", messageId: opts.messageId });
  await db().prepare("UPDATE slots SET start_at = ?, end_at = ?, all_day = ? WHERE id = ?").bind(startAt, opts.allDay ? null : startAt + 7200, opts.allDay ? 1 : 0, s.slotIds[0]).run();
  await db()
    .prepare("UPDATE polls SET fixed_slot_id = ?, fixed_at = 1, target_type = ?, target_id = ? WHERE id = ?")
    .bind(s.slotIds[0], opts.role ? "role" : "channel", opts.role ?? null, s.pollId)
    .run();
  return s;
}

const reminders = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`).map((c) => c.body as { content: string; allowed_mentions: unknown; message_reference?: unknown });
const startsOf = (calls: { method: string; path: string; body: unknown }[]) => reminders(calls).map((m) => m.content.match(/<t:(\d+):t>/)?.[1] ?? "終日");

describe("予定のリマインド（§5.7）", () => {
  it("17 時の回は、当日 18:00〜24:00・翌日 0:00〜10:59 の予定と、翌日の終日の予定に送る", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T18:00")); // 送る（今日）
    await fixedPoll(jst("2026-11-06T23:30")); // 送る（今日）
    await fixedPoll(jst("2026-11-07T00:00")); // 送る（明日）
    await fixedPoll(jst("2026-11-07T10:59")); // 送る（明日）
    await fixedPoll(jst("2026-11-07T00:00"), { allDay: true }); // 送る（明日・終日）
    await fixedPoll(jst("2026-11-06T17:59")); // 送らない（10 時の回の分）
    await fixedPoll(jst("2026-11-07T11:00")); // 送らない（翌日の 10 時の回の分）
    await fixedPoll(jst("2026-11-06T00:00"), { allDay: true }); // 送らない（当日の終日）
    await fixedPoll(jst("2026-11-08T00:00"), { allDay: true }); // 送らない（翌々日の終日）
    await runCron(testEnv(), AT_17);
    expect(startsOf(calls).sort()).toEqual(
      [String(jst("2026-11-06T18:00")), String(jst("2026-11-06T23:30")), String(jst("2026-11-07T00:00")), String(jst("2026-11-07T10:59")), "終日"].sort(),
    );
  });

  it("10 時の回は、当日 11:00〜17:59 の予定だけに送る", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T11:00")); // 送る
    await fixedPoll(jst("2026-11-06T17:59")); // 送る
    await fixedPoll(jst("2026-11-06T10:30")); // 送らない（前日の 17 時の回の分）
    await fixedPoll(jst("2026-11-06T18:00")); // 送らない（17 時の回の分）
    await fixedPoll(jst("2026-11-07T00:00"), { allDay: true }); // 送らない（17 時の回の分）
    await runCron(testEnv(), AT_10);
    expect(startsOf(calls)).toEqual([String(jst("2026-11-06T11:00")), String(jst("2026-11-06T17:59"))]);
  });

  it("当日の予定は「今日」、翌日の予定は「明日」と書く", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T21:00"));
    await fixedPoll(jst("2026-11-07T09:00"));
    await fixedPoll(jst("2026-11-07T00:00"), { allDay: true });
    await runCron(testEnv(), AT_17);
    const texts = reminders(calls).map((m) => m.content.split("\n")[0]);
    expect(texts).toEqual([
      `**定例会** は今日 <t:${jst("2026-11-06T21:00")}:t> からです。`,
      "**定例会** は明日です（終日）。",
      `**定例会** は明日 <t:${jst("2026-11-07T09:00")}:t> からです。`,
    ]);
  });

  it("確定していない調整には送らない", async () => {
    const calls = mockDiscord();
    const s = await fixedPoll(jst("2026-11-06T21:00"));
    await db().prepare("UPDATE polls SET status = 'open' WHERE id = ?").bind(s.pollId).run();
    await runCron(testEnv(), AT_17);
    expect(reminders(calls).length).toBe(0);
  });

  it("募集メッセージへの返信で、リンクを入れ、ロールがなければ @everyone をメンションする", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T21:00"));
    await runCron(testEnv(), AT_17);
    const m = reminders(calls)[0]!;
    expect(m.content).toContain("https://discord.com/channels/");
    expect(m.content).toContain("@everyone");
    expect(m.allowed_mentions).toEqual({ parse: ["everyone"], replied_user: false });
    expect(m.message_reference).toEqual({ message_id: "500000000000000001", fail_if_not_exists: false });
  });

  it("ロールの調整はロールだけをメンションする。募集メッセージがなければ返信にしない", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T21:00"), { role: "400000000000000077", messageId: null });
    await runCron(testEnv(), AT_17);
    const m = reminders(calls)[0]!;
    expect(m.content).toContain("<@&400000000000000077>");
    expect(m.content).not.toContain("@everyone");
    expect(m.allowed_mentions).toEqual({ parse: [], roles: ["400000000000000077"], replied_user: false });
    expect(m.message_reference).toBeUndefined();
  });

  it("同じ確定日時には 2 回送らない。確定し直して日時が変わったら送る", async () => {
    const calls = mockDiscord();
    const s = await fixedPoll(jst("2026-11-06T21:00"));
    await runCron(testEnv(), AT_17);
    await runCron(testEnv(), AT_17 + 60_000);
    expect(reminders(calls).length).toBe(1);
    await db().prepare("UPDATE slots SET start_at = ? WHERE id = ?").bind(jst("2026-11-06T22:00"), s.slotIds[0]).run();
    await runCron(testEnv(), AT_17 + 120_000);
    expect(reminders(calls).length).toBe(2);
  });

  it(`1 回の実行では ${DAY_REMINDER_MAX_PER_RUN} 件まで送り、残りは次の分の回で送る`, async () => {
    const calls = mockDiscord();
    for (let i = 0; i < DAY_REMINDER_MAX_PER_RUN + 3; i++) await fixedPoll(jst("2026-11-06T21:00") + i);
    await runCron(testEnv(), AT_17);
    expect(reminders(calls).length).toBe(DAY_REMINDER_MAX_PER_RUN);
    await runCron(testEnv(), AT_17 + 60_000);
    expect(reminders(calls).length).toBe(DAY_REMINDER_MAX_PER_RUN + 3);
  });

  it("投稿に失敗しても、ほかの調整の処理は続け、失敗した調整には送り直さない", async () => {
    let n = 0;
    const calls = mockDiscord((c) => (c.method === "POST" && n++ === 0 ? new Response("{}", { status: 403 }) : {}));
    await fixedPoll(jst("2026-11-06T21:00"));
    await fixedPoll(jst("2026-11-06T22:00"));
    await runCron(testEnv(), AT_17);
    expect(reminders(calls).length).toBe(2);
    await runCron(testEnv(), AT_17 + 60_000);
    expect(reminders(calls).length).toBe(2);
  });

  it("10 時・17 時の回では、募集メッセージの更新・コマンドの登録・サーバーの一覧の読み込みをしない", async () => {
    const calls = mockDiscord();
    await seedPoll({ deadlineAt: 1000 });
    await runCron(testEnv(), AT_10);
    await runCron(testEnv(), AT_17);
    expect(calls.some((c) => c.method === "PATCH" || c.method === "PUT" || c.path.startsWith("/users/@me/guilds"))).toBe(false);
  });

  it("13 時・1 時の回では送らない", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [] : {}));
    await fixedPoll(jst("2026-11-06T21:00"));
    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(reminders(calls).length).toBe(0);
  });

  it("範囲は日本時間で決め、0〜4 分のどの回でも同じになる", () => {
    const at17 = reminderWindow(AT_17 + 4 * 60_000)!;
    expect(at17.timed).toEqual({ from: jst("2026-11-06T18:00"), to: jst("2026-11-07T11:00") });
    expect(at17.allDay).toEqual({ from: jst("2026-11-07T00:00"), to: jst("2026-11-08T00:00") });
    const at10 = reminderWindow(AT_10 + 4 * 60_000)!;
    expect(at10.timed).toEqual({ from: jst("2026-11-06T11:00"), to: jst("2026-11-06T18:00") });
    expect(at10.allDay).toBeNull();
    expect(reminderWindow(Date.parse("2026-11-06T04:00:00Z"))).toBeNull();
  });
});
