import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { runCron } from "../src/jobs/cron";
import { DAY_REMINDER_MAX_PER_RUN, dayReminderRange } from "../src/jobs/day-reminder";
import { CHANNEL, mockDiscord, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

/** 日本時間 2026-11-06 19:00 の Cron */
const AT_19 = Date.parse("2026-11-06T10:00:00Z");
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** 確定済みの調整を作り、確定した候補の開始時刻を startAt にする */
async function fixedPoll(startAt: number, opts: { allDay?: boolean; role?: string; messageId?: string | null } = {}) {
  const s = await seedPoll({ status: "fixed", messageId: opts.messageId });
  await db().prepare("UPDATE slots SET start_at = ?, end_at = ?, all_day = ? WHERE id = ?").bind(startAt, startAt + 7200, opts.allDay ? 1 : 0, s.slotIds[0]).run();
  await db()
    .prepare("UPDATE polls SET fixed_slot_id = ?, fixed_at = 1, target_type = ?, target_id = ? WHERE id = ?")
    .bind(s.slotIds[0], opts.role ? "role" : "channel", opts.role ?? null, s.pollId)
    .run();
  return s;
}

const reminders = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`).map((c) => c.body as { content: string; allowed_mentions: unknown; message_reference?: unknown });

describe("当日のリマインド（§5.7）", () => {
  it("日本時間の当日 19:00〜24:00 に始まる確定日時だけに送る", async () => {
    const calls = mockDiscord();
    await fixedPoll(sec("2026-11-06T12:00:00Z")); // 21:00 → 送る
    await fixedPoll(sec("2026-11-06T10:00:00Z")); // 19:00 ちょうど → 送る
    await fixedPoll(sec("2026-11-06T09:00:00Z")); // 18:00 → 送らない
    await fixedPoll(sec("2026-11-06T15:00:00Z")); // 翌日 0:00 → 送らない
    await fixedPoll(sec("2026-11-06T12:00:00Z"), { allDay: true }); // 終日 → 送らない
    await runCron(testEnv(), AT_19);
    const r = reminders(calls);
    expect(r.length).toBe(2);
    expect(r.map((m) => m.content.match(/<t:(\d+):t>/)![1])).toEqual([String(sec("2026-11-06T10:00:00Z")), String(sec("2026-11-06T12:00:00Z"))]);
  });

  it("確定していない調整には送らない", async () => {
    const calls = mockDiscord();
    const s = await fixedPoll(sec("2026-11-06T12:00:00Z"));
    await db().prepare("UPDATE polls SET status = 'open' WHERE id = ?").bind(s.pollId).run();
    await runCron(testEnv(), AT_19);
    expect(reminders(calls).length).toBe(0);
  });

  it("募集メッセージへの返信で、タイトルとリンクを入れ、ロールがなければ @everyone をメンションする", async () => {
    const calls = mockDiscord();
    await fixedPoll(sec("2026-11-06T12:00:00Z"));
    await runCron(testEnv(), AT_19);
    const m = reminders(calls)[0]!;
    expect(m.content).toContain("**定例会** は今日 <t:");
    expect(m.content).toContain(`https://discord.com/channels/`);
    expect(m.content).toContain("@everyone");
    expect(m.allowed_mentions).toEqual({ parse: ["everyone"], replied_user: false });
    expect(m.message_reference).toEqual({ message_id: "500000000000000001", fail_if_not_exists: false });
  });

  it("ロールの調整はロールだけをメンションする。募集メッセージがなければ返信にしない", async () => {
    const calls = mockDiscord();
    await fixedPoll(sec("2026-11-06T12:00:00Z"), { role: "400000000000000077", messageId: null });
    await runCron(testEnv(), AT_19);
    const m = reminders(calls)[0]!;
    expect(m.content).toContain("<@&400000000000000077>");
    expect(m.content).not.toContain("@everyone");
    expect(m.allowed_mentions).toEqual({ parse: [], roles: ["400000000000000077"], replied_user: false });
    expect(m.message_reference).toBeUndefined();
  });

  it("同じ確定日時には 2 回送らない。確定し直して日時が変わったら送る", async () => {
    const calls = mockDiscord();
    const s = await fixedPoll(sec("2026-11-06T12:00:00Z"));
    await runCron(testEnv(), AT_19);
    await runCron(testEnv(), AT_19 + 60_000);
    expect(reminders(calls).length).toBe(1);
    await db().prepare("UPDATE slots SET start_at = ? WHERE id = ?").bind(sec("2026-11-06T13:00:00Z"), s.slotIds[0]).run();
    await runCron(testEnv(), AT_19 + 120_000);
    expect(reminders(calls).length).toBe(2);
  });

  it(`1 回の実行では ${DAY_REMINDER_MAX_PER_RUN} 件まで送り、残りは次の分の回で送る`, async () => {
    const calls = mockDiscord();
    for (let i = 0; i < DAY_REMINDER_MAX_PER_RUN + 3; i++) await fixedPoll(sec("2026-11-06T12:00:00Z") + i);
    await runCron(testEnv(), AT_19);
    expect(reminders(calls).length).toBe(DAY_REMINDER_MAX_PER_RUN);
    await runCron(testEnv(), AT_19 + 60_000);
    expect(reminders(calls).length).toBe(DAY_REMINDER_MAX_PER_RUN + 3);
  });

  it("投稿に失敗しても、ほかの調整の処理は続け、失敗した調整には送り直さない", async () => {
    let n = 0;
    const calls = mockDiscord((c) => (c.method === "POST" && n++ === 0 ? new Response("{}", { status: 403 }) : {}));
    await fixedPoll(sec("2026-11-06T12:00:00Z"));
    await fixedPoll(sec("2026-11-06T13:00:00Z"));
    await runCron(testEnv(), AT_19);
    expect(reminders(calls).length).toBe(2);
    await runCron(testEnv(), AT_19 + 60_000);
    expect(reminders(calls).length).toBe(2);
  });

  it("19 時台の回では、募集メッセージの更新・コマンドの登録・サーバーの一覧の読み込みをしない", async () => {
    const calls = mockDiscord();
    await seedPoll({ deadlineAt: 1000 });
    await runCron(testEnv(), AT_19);
    expect(calls.some((c) => c.method === "PATCH" || c.method === "PUT" || c.path.startsWith("/users/@me/guilds"))).toBe(false);
  });

  it("13 時・1 時の回では送らない", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [] : {}));
    await fixedPoll(sec("2026-11-06T12:00:00Z"));
    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(reminders(calls).length).toBe(0);
  });

  it("日付の区切りは日本時間で決める", () => {
    expect(dayReminderRange(Date.parse("2026-11-06T10:04:00Z"))).toEqual({ from: sec("2026-11-06T10:00:00Z"), to: sec("2026-11-06T15:00:00Z") });
  });
});
