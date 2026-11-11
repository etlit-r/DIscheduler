import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { runCron } from "../src/jobs/cron";
import { DAY_REMINDER_MAX_PER_RUN, REMINDER_CRON } from "../src/jobs/day-reminder";
import { reminderAt } from "../src/shared/model";
import { CHANNEL, mockDiscord, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());
// ほかのテストで作った確定済みの調整が、範囲に入って送られないようにする
beforeEach(async () => {
  await db().prepare("DELETE FROM polls").run();
});

/** 日本時間の日時（"2026-11-06T18:00"）を UNIX 秒にする */
const jst = (local: string) => Math.floor(Date.parse(`${local}:00+09:00`) / 1000);
/** 日本時間の日時に、予定のリマインドの Cron を動かす */
const remindAt = (local: string) => runCron(testEnv(), jst(local) * 1000, REMINDER_CRON);

/** 確定済みの調整を作り、確定した候補の開始時刻を startAt にする */
async function fixedPoll(
  startAt: number,
  opts: { allDay?: boolean; role?: string; messageId?: string | null; timezone?: string; dayOffset?: number; hour?: number } = {},
) {
  const s = await seedPoll({ status: "fixed", messageId: opts.messageId });
  await db().prepare("UPDATE slots SET start_at = ?, end_at = ?, all_day = ?, fixed_at = 1 WHERE id = ?").bind(startAt, opts.allDay ? null : startAt + 7200, opts.allDay ? 1 : 0, s.slotIds[0]).run();
  await db()
    .prepare("UPDATE polls SET target_type = ?, target_id = ?, timezone = ?, remind_day_offset = ?, remind_hour = ? WHERE id = ?")
    .bind(opts.role ? "role" : "channel", opts.role ?? null, opts.timezone ?? "Asia/Tokyo", opts.dayOffset ?? 0, opts.hour ?? 17, s.pollId)
    .run();
  return s;
}

const reminders = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`).map((c) => c.body as { content: string; allowed_mentions: unknown; message_reference?: unknown });
const startsOf = (calls: { method: string; path: string; body: unknown }[]) => reminders(calls).map((m) => m.content.match(/<t:(\d+):f>/)?.[1] ?? "終日");

describe("予定のリマインド（§5.7）", () => {
  it("既定は予定の当日の 17 時。17 時より前に始まる予定には送らない", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T21:00")); // 送る（当日 17 時）
    await fixedPoll(jst("2026-11-06T16:00")); // 送らない（17 時には始まっている）
    await fixedPoll(jst("2026-11-07T21:00")); // まだ（翌日の 17 時）
    await remindAt("2026-11-06T16:00");
    expect(reminders(calls).length).toBe(0);
    await remindAt("2026-11-06T17:00");
    expect(startsOf(calls)).toEqual([String(jst("2026-11-06T21:00"))]);
    await remindAt("2026-11-07T17:00");
    expect(startsOf(calls)).toEqual([String(jst("2026-11-06T21:00")), String(jst("2026-11-07T21:00"))]);
  });

  it("主催者が決めた日時（前日の何時か、当日の何時か）に送る", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-07T10:00"), { dayOffset: 1, hour: 20 }); // 前日 20 時
    await fixedPoll(jst("2026-11-07T10:00"), { dayOffset: 0, hour: 8 }); // 当日 8 時
    await remindAt("2026-11-06T19:00");
    expect(reminders(calls).length).toBe(0);
    await remindAt("2026-11-06T20:00");
    expect(reminders(calls).length).toBe(1);
    await remindAt("2026-11-07T07:00");
    expect(reminders(calls).length).toBe(1);
    await remindAt("2026-11-07T08:00");
    expect(reminders(calls).length).toBe(2);
  });

  it("時刻は調整のタイムゾーンで決める", async () => {
    const calls = mockDiscord();
    // ニューヨークの 11/6 20:00 の予定は、ニューヨークの 11/6 17:00（日本時間 11/7 7:00）に送る
    const start = Math.floor(Date.parse("2026-11-06T20:00:00-05:00") / 1000);
    await fixedPoll(start, { timezone: "America/New_York" });
    await remindAt("2026-11-07T06:00");
    expect(reminders(calls).length).toBe(0);
    await remindAt("2026-11-07T07:00");
    expect(reminders(calls).length).toBe(1);
  });

  it("終日の予定は、その日が終わるまでに送る。日付で書く", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-07T00:00"), { allDay: true }); // 当日 17 時
    await fixedPoll(jst("2026-11-07T21:00"));
    await remindAt("2026-11-07T17:00");
    const texts = reminders(calls).map((m) => m.content.split("\n")[0]).sort();
    expect(texts).toEqual(["**定例会** は 11/7(土) です（終日）。", `**定例会** は <t:${jst("2026-11-07T21:00")}:f> からです。`].sort());
  });

  it("送る時刻を過ぎてから確定した日時は、次の回で送る。始まった予定には送らない", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T21:00"));
    await fixedPoll(jst("2026-11-06T18:00"));
    await remindAt("2026-11-06T19:00");
    expect(startsOf(calls)).toEqual([String(jst("2026-11-06T21:00"))]);
  });

  it("確定していない調整・確定していない候補には送らない", async () => {
    const calls = mockDiscord();
    const s = await fixedPoll(jst("2026-11-06T21:00"));
    await db().prepare("UPDATE slots SET start_at = ?, end_at = ? WHERE id = ?").bind(jst("2026-11-06T22:00"), jst("2026-11-06T23:00"), s.slotIds[1]).run();
    const t = await fixedPoll(jst("2026-11-06T21:00"));
    await db().prepare("UPDATE polls SET status = 'open' WHERE id = ?").bind(t.pollId).run();
    await remindAt("2026-11-06T17:00");
    expect(startsOf(calls)).toEqual([String(jst("2026-11-06T21:00"))]);
  });

  it("募集メッセージへの返信で、リンクを入れ、ロールがなければ @everyone をメンションする", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T21:00"));
    await remindAt("2026-11-06T17:00");
    const m = reminders(calls)[0]!;
    expect(m.content).toContain("https://discord.com/channels/");
    expect(m.content).toContain("@everyone");
    expect(m.allowed_mentions).toEqual({ parse: ["everyone"], replied_user: false });
    expect(m.message_reference).toEqual({ message_id: "500000000000000001", fail_if_not_exists: false });
  });

  it("ロールの調整はロールだけをメンションする。募集メッセージがなければ返信にしない", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-06T21:00"), { role: "400000000000000077", messageId: null });
    await remindAt("2026-11-06T17:00");
    const m = reminders(calls)[0]!;
    expect(m.content).toContain("<@&400000000000000077>");
    expect(m.content).not.toContain("@everyone");
    expect(m.allowed_mentions).toEqual({ parse: [], roles: ["400000000000000077"], replied_user: false });
    expect(m.message_reference).toBeUndefined();
  });

  it("同じ確定日時には 2 回送らない。確定した候補の日時が変わったら送る", async () => {
    const calls = mockDiscord();
    const s = await fixedPoll(jst("2026-11-06T21:00"));
    await remindAt("2026-11-06T17:00");
    await remindAt("2026-11-06T18:00");
    expect(reminders(calls).length).toBe(1);
    await db().prepare("UPDATE slots SET start_at = ? WHERE id = ?").bind(jst("2026-11-06T22:00"), s.slotIds[0]).run();
    await remindAt("2026-11-06T19:00");
    expect(reminders(calls).length).toBe(2);
  });

  it("確定した日時が複数ある調整は、日時ごとに送る", async () => {
    const calls = mockDiscord();
    const s = await fixedPoll(jst("2026-11-06T21:00"));
    await db().prepare("UPDATE slots SET start_at = ?, end_at = ?, fixed_at = 1 WHERE id = ?").bind(jst("2026-11-07T19:00"), jst("2026-11-07T20:00"), s.slotIds[1]).run();
    await remindAt("2026-11-06T17:00");
    expect(startsOf(calls)).toEqual([String(jst("2026-11-06T21:00"))]);
    await remindAt("2026-11-07T17:00");
    expect(startsOf(calls)).toEqual([String(jst("2026-11-06T21:00")), String(jst("2026-11-07T19:00"))]);
  });

  it(`1 回の実行では ${DAY_REMINDER_MAX_PER_RUN} 件まで送り、残りは次の分の回で送る`, async () => {
    const calls = mockDiscord();
    for (let i = 0; i < DAY_REMINDER_MAX_PER_RUN + 3; i++) await fixedPoll(jst("2026-11-06T21:00") + i);
    await remindAt("2026-11-06T17:00");
    expect(reminders(calls).length).toBe(DAY_REMINDER_MAX_PER_RUN);
    await remindAt("2026-11-06T17:01");
    expect(reminders(calls).length).toBe(DAY_REMINDER_MAX_PER_RUN + 3);
  });

  it("投稿に失敗しても、ほかの調整の処理は続け、失敗した調整には送り直さない", async () => {
    let n = 0;
    const calls = mockDiscord((c) => (c.method === "POST" && n++ === 0 ? new Response("{}", { status: 403 }) : {}));
    await fixedPoll(jst("2026-11-06T21:00"));
    await fixedPoll(jst("2026-11-06T22:00"));
    await remindAt("2026-11-06T17:00");
    expect(reminders(calls).length).toBe(2);
    await remindAt("2026-11-06T17:01");
    expect(reminders(calls).length).toBe(2);
  });

  it("リマインドの回では、募集メッセージの更新・コマンドの登録・サーバーの一覧の読み込みをしない", async () => {
    const calls = mockDiscord();
    await seedPoll({ deadlineAt: 1000 });
    await remindAt("2026-11-06T13:00");
    await remindAt("2026-11-06T01:00");
    expect(calls.some((c) => c.method === "PATCH" || c.method === "PUT" || c.path.startsWith("/users/@me/guilds"))).toBe(false);
  });

  it("13 時・1 時の Cron では送らない", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [] : {}));
    await fixedPoll(jst("2026-11-06T21:00"));
    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(reminders(calls).length).toBe(0);
  });

  it("送る時刻の計算（前日・当日、夏時間、開始後なら送らない）", () => {
    const tokyo = (iso: string, allDay = false) => ({ startAt: jst(iso), allDay });
    expect(reminderAt(tokyo("2026-11-07T21:00"), "Asia/Tokyo", 0, 17)).toBe(jst("2026-11-07T17:00"));
    expect(reminderAt(tokyo("2026-11-07T21:00"), "Asia/Tokyo", 1, 9)).toBe(jst("2026-11-06T09:00"));
    expect(reminderAt(tokyo("2026-11-01T10:00"), "Asia/Tokyo", 1, 0)).toBe(jst("2026-10-31T00:00"));
    expect(reminderAt(tokyo("2026-11-07T10:00"), "Asia/Tokyo", 0, 17)).toBeNull();
    expect(reminderAt(tokyo("2026-11-07T00:00", true), "Asia/Tokyo", 0, 17)).toBe(jst("2026-11-07T17:00"));
    // ニューヨークの夏時間の終わり（2026-11-01）をまたいでも、壁時計の時刻で決める
    const ny = Math.floor(Date.parse("2026-11-01T20:00:00-05:00") / 1000);
    expect(reminderAt({ startAt: ny, allDay: false }, "America/New_York", 1, 17)).toBe(Math.floor(Date.parse("2026-10-31T17:00:00-04:00") / 1000));
  });
});
