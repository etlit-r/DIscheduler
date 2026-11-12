// 自動処理（Cron・予定のリマインド）の分岐とログ（Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { resetCommandsCache } from "../src/discord/commands";
import { parseWebhookUrl, runCron } from "../src/jobs/cron";
import { DAY_REMINDER_MAX_PER_RUN, isReminderDue, REMINDER_CRON } from "../src/jobs/day-reminder";
import { ALICE, CHANNEL, GUILD, jst, mockDiscord, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
const NOON = Date.parse("2026-11-06T04:00:00Z");
const NIGHT = Date.parse("2026-11-06T16:00:00Z");
const WEBHOOK = "https://discord.com/api/webhooks/900000000000000001/abcdefghijklmnopqrstuvwxyz0123456789";
const nowS = () => Math.floor(Date.now() / 1000);
const guildsOf = (ids: string[]) => (c: { path: string }) => (c.path.startsWith("/users/@me/guilds") ? ids.map((id) => ({ id })) : {});
const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await db().prepare("DELETE FROM polls").run();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Cron の募集メッセージの更新", () => {
  it("締め切った調整は、募集メッセージがあるものだけ更新し、未反映の回答もある調整は 1 回だけ更新する", async () => {
    const calls = mockDiscord(guildsOf([GUILD]));
    const a = await seedPoll({ deadlineAt: 1000 });
    await seedPoll({ deadlineAt: 1000, messageId: null });
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(a.pollId, a.slotIds[0], ALICE, a.choiceIds[0], nowS()).run();
    await runCron(testEnv(), NOON);
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/"))).toHaveLength(1);
  });

  it("締め切った調整だけで上限に達したら、未反映の回答の調整は次の回", async () => {
    const calls = mockDiscord(guildsOf([GUILD]));
    for (let i = 0; i < 9; i++) await seedPoll({ deadlineAt: 1000 });
    const p = await seedPoll();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(p.pollId, p.slotIds[0], ALICE, p.choiceIds[0], nowS()).run();
    await runCron(testEnv(), NOON);
    const patched = calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/"));
    expect(patched).toHaveLength(8);
    expect(JSON.stringify(patched.map((c) => c.body))).not.toContain(p.pollId);
  });

  it("最後にコマンドの登録を確かめる（force: この isolate で確認済みでも D1 を読み直す）。失敗はログに残す", async () => {
    const calls = mockDiscord(guildsOf([GUILD]));
    resetCommandsCache();
    await runCron(testEnv(), NOON);
    await db().prepare("UPDATE meta SET value = 'old' WHERE key = 'commands_version'").run();
    calls.length = 0;
    await runCron(testEnv(), NOON);
    expect(calls.filter((c) => c.method === "PUT" && c.path.endsWith("/commands"))).toHaveLength(1);

    // fetch の差し替えだけを戻す（console の差し替えは残す）
    vi.mocked(globalThis.fetch).mockRestore();
    mockDiscord((c) => (c.path.endsWith("/commands") ? new Response("{}", { status: 500 }) : {}));
    await db().prepare("UPDATE meta SET value = 'old' WHERE key = 'commands_version'").run();
    await runCron(testEnv(), NOON);
    expect(logged(err).map((e) => e.event)).toContain("commands_sync_failed");
  });
});

describe("Cron の削除（日本時間 1 時）", () => {
  it("期限切れのリンク・セッション・回数制限・一覧のリンクとセッションを消し、期限内のものは残す", async () => {
    mockDiscord(guildsOf([GUILD]));
    const { pollId } = await seedPoll();
    const now = nowS();
    const ins = (sql: string, ...v: unknown[]) => db().prepare(sql).bind(...v).run();
    for (const [k, exp] of [["old", now - 1], ["new", now + 600]] as const) {
      await ins("INSERT INTO link_tokens (token_hash, poll_id, user_id, role, purpose, expires_at) VALUES (?, ?, ?, 'participant', 'answer', ?)", `lt-${k}`, pollId, ALICE, exp);
      await ins("INSERT INTO sessions (sid_hash, poll_id, user_id, role, csrf_token, expires_at, created_at) VALUES (?, ?, ?, 'participant', 'c', ?, 0)", `s-${k}`, pollId, ALICE, exp);
      await ins("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)", `rl-${k}`, exp);
      await ins("INSERT INTO list_tokens (token_hash, guild_id, user_id, expires_at) VALUES (?, ?, ?, ?)", `lt2-${k}`, GUILD, ALICE, exp);
      await ins("INSERT INTO list_sessions (sid_hash, guild_id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, 'c', ?, 0)", `ls-${k}`, GUILD, ALICE, exp);
    }
    await runCron(testEnv(), NIGHT);
    for (const [table, col, prefix] of [
      ["link_tokens", "token_hash", "lt-"],
      ["sessions", "sid_hash", "s-"],
      ["rate_limits", "key", "rl-"],
      ["list_tokens", "token_hash", "lt2-"],
      ["list_sessions", "sid_hash", "ls-"],
    ]) {
      const rows = await db().prepare(`SELECT ${col} AS k FROM ${table} WHERE ${col} LIKE ?`).bind(`${prefix}%`).all<{ k: string }>();
      expect(rows.results.map((r) => r.k), table).toEqual([`${prefix}new`]);
    }
    expect(logged(log)).toContainEqual({ event: "cleanup_done" });
    expect(logged(log)).toContainEqual({ event: "guild_count", count: 1, complete: true });
  });

  it("外されたサーバーの既定値・一覧のリンクとセッションも消す。残っているサーバーのものは残す", async () => {
    const gone = "200000000000000555";
    mockDiscord(guildsOf([GUILD]));
    const now = nowS();
    await db().batch(["guild_settings", "list_tokens", "list_sessions"].map((t) => db().prepare(`DELETE FROM ${t}`)));
    for (const g of [GUILD, gone]) {
      await db().prepare("INSERT OR REPLACE INTO guild_settings (guild_id, mode, updated_by, updated_at) VALUES (?, 'manual', 'u', 0)").bind(g).run();
      await db().prepare("INSERT INTO list_tokens (token_hash, guild_id, user_id, expires_at) VALUES (?, ?, 'u', ?)").bind(`t-${g}`, g, now + 600).run();
      await db().prepare("INSERT INTO list_sessions (sid_hash, guild_id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, 'u', 'c', ?, 0)").bind(`s-${g}`, g, now + 600).run();
    }
    await runCron(testEnv(), NIGHT);
    for (const t of ["guild_settings", "list_tokens", "list_sessions"]) {
      const rows = await db().prepare(`SELECT guild_id FROM ${t} WHERE guild_id IN (?, ?)`).bind(GUILD, gone).all<{ guild_id: string }>();
      expect(rows.results.map((r) => r.guild_id), t).toEqual([GUILD]);
    }
  });

  it("サーバーの一覧は 200 件ごとに、最後の ID の次から読む", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: String(700000000000000000n + BigInt(i)) }));
    const calls = mockDiscord((c) => (c.path === "/users/@me/guilds?limit=200&after=0" ? page1 : c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    await runCron(testEnv(), NIGHT);
    expect(calls.filter((c) => c.path.startsWith("/users/@me/guilds")).map((c) => c.path)).toEqual([
      "/users/@me/guilds?limit=200&after=0",
      `/users/@me/guilds?limit=200&after=${page1[199]!.id}`,
    ]);
    expect(logged(log)).toContainEqual({ event: "guild_count", count: 201, complete: true });
  });

  it("一覧を読み切れなければ、読めた数を残して削除しない", async () => {
    let n = 0;
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? Array.from({ length: 200 }, () => ({ id: String(800000000000000000n + BigInt(n++)) })) : {}));
    await runCron(testEnv(), NIGHT);
    expect(calls.filter((c) => c.path.startsWith("/users/@me/guilds"))).toHaveLength(10);
    expect(logged(log)).toContainEqual({ event: "guild_count", count: 2000, complete: false });
    expect(logged(err)).toContainEqual({ event: "guild_check_skipped", reason: "guild_list_incomplete", read: 2000 });
  });

  it("一覧の読み込みに失敗しても、削除の残りは終える", async () => {
    mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? new Response("{}", { status: 500 }) : {}));
    const { pollId } = await seedPoll();
    await runCron(testEnv(), NIGHT);
    expect(logged(err)).toContainEqual({ event: "guild_check_failed", error: "Discord API 500 /users/@me/guilds?limit=200&after=0" });
    expect(logged(log)).toContainEqual({ event: "cleanup_done" });
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(pollId).first()).not.toBeNull();
  });
});

describe("サーバーの数の通知", () => {
  const many = Array.from({ length: 76 }, (_, i) => String(100000000000000000n + BigInt(i)));
  beforeEach(async () => {
    await db().prepare("DELETE FROM meta WHERE key = 'guild_alert_sent'").run();
  });

  it("Webhook の URL がない・正しくなければ、理由をログに残す", async () => {
    mockDiscord(guildsOf(many));
    await runCron(testEnv(), NIGHT);
    expect(logged(err)).toContainEqual({ event: "guild_alert_skipped", reason: "no_webhook_url", count: 76 });
    await runCron(testEnv({ ALERT_WEBHOOK_URL: "https://example.com/x" }), NIGHT);
    expect(logged(err)).toContainEqual({ event: "guild_alert_skipped", reason: "bad_webhook_url", count: 76 });
  });

  it("通知はトークンなしで送り、メンションを無効にする", async () => {
    const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(url.includes("/users/@me/guilds") ? many.map((id) => ({ id })) : {}), { status: 200 });
    });
    await runCron(testEnv({ ALERT_WEBHOOK_URL: WEBHOOK }), NIGHT);
    const hook = sent.find((s) => s.url.includes("/webhooks/900000000000000001/"))!;
    expect(hook.headers.Authorization).toBeUndefined();
    expect(hook.body).toEqual({ content: "DIscheduler の Bot が入っているサーバーが 76 になりました（通知の目安: 75）。", allowed_mentions: { parse: [] } });
    const meta = await db().prepare("SELECT value FROM meta WHERE key = 'guild_alert_sent'").first<{ value: string }>();
    expect(meta!.value).toBe("76");
  });

  it("通知に失敗したら記録せず、次の回にまた送る", async () => {
    mockDiscord((c) => (c.path.startsWith("/webhooks/") ? new Response("{}", { status: 500 }) : guildsOf(many)(c)));
    await runCron(testEnv({ ALERT_WEBHOOK_URL: WEBHOOK }), NIGHT);
    expect(logged(err).find((e) => e.event === "guild_alert_failed")!.error).toContain("Discord API 500 /webhooks/");
    expect(await db().prepare("SELECT value FROM meta WHERE key = 'guild_alert_sent'").first()).toBeNull();
  });

  it("Webhook の URL は前後の空白を許し、パスの前後に余計なものがあれば受け付けない", () => {
    const id = "900000000000000001";
    const token = "abcdefghijklmnopqrstuvwxyz0123456789";
    expect(parseWebhookUrl(`  https://discord.com/api/webhooks/${id}/${token}  `)).toEqual({ id, token });
    for (const host of ["ptb.discordapp.com", "canary.discordapp.com", "discordapp.com"]) {
      expect(parseWebhookUrl(`https://${host}/api/webhooks/${id}/${token}`)).toEqual({ id, token });
    }
    expect(parseWebhookUrl(`https://discord.com/x/api/webhooks/${id}/${token}`)).toBeNull();
    expect(parseWebhookUrl(`https://discord.com/api/webhooks/${id}/${token}/x`)).toBeNull();
    expect(parseWebhookUrl(`https://discord.com/api/webhooks/${id}/${token}/messages/1`)).toBeNull();
  });
});

describe("予定のリマインド", () => {
  const t = (start: string, opts: { allDay?: boolean; offset?: number; hour?: number } = {}) => ({
    start_at: jst(start),
    all_day: opts.allDay ? 1 : 0,
    timezone: "Asia/Tokyo",
    remind_day_offset: opts.offset ?? 0,
    remind_hour: opts.hour ?? 17,
  });

  it("送る時刻ちょうどから、予定の開始の直前まで", () => {
    expect(isReminderDue(t("2026-11-06T20:00"), jst("2026-11-06T16:59"))).toBe(false);
    expect(isReminderDue(t("2026-11-06T20:00"), jst("2026-11-06T17:00"))).toBe(true);
    expect(isReminderDue(t("2026-11-06T20:00"), jst("2026-11-06T20:00") - 1)).toBe(true);
    expect(isReminderDue(t("2026-11-06T20:00"), jst("2026-11-06T20:00"))).toBe(false);
  });

  it("送る時刻が予定の開始より後なら、送らない", () => {
    expect(isReminderDue(t("2026-11-06T20:00", { hour: 21 }), jst("2026-11-06T19:00"))).toBe(false);
  });

  it("終日の予定は、その日が終わるまで", () => {
    expect(isReminderDue(t("2026-11-06T00:00", { allDay: true, hour: 23 }), jst("2026-11-06T23:59"))).toBe(true);
    expect(isReminderDue(t("2026-11-06T00:00", { allDay: true }), jst("2026-11-07T00:00"))).toBe(false);
  });

  async function fixedPoll(startAt: number, opts: { offset?: number; hour?: number } = {}) {
    const s = await seedPoll({ status: "fixed" });
    await db().prepare("UPDATE slots SET start_at = ?, end_at = ?, fixed_at = 1 WHERE id = ?").bind(startAt, startAt + 3600, s.slotIds[0]).run();
    await db().prepare("UPDATE polls SET remind_day_offset = ?, remind_hour = ? WHERE id = ?").bind(opts.offset ?? 0, opts.hour ?? 17, s.pollId).run();
    return s;
  }
  const remindAt = (local: string) => runCron(testEnv(), jst(local) * 1000, REMINDER_CRON);
  const posts = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`);

  it("前日の 0 時に送る設定なら、47 時間先の予定も読み込む", async () => {
    const calls = mockDiscord();
    await fixedPoll(jst("2026-11-08T23:00"), { offset: 1, hour: 0 });
    await remindAt("2026-11-07T00:00");
    expect(posts(calls)).toHaveLength(1);
  });

  it("送った数・残り・失敗をログに残す。403・404 以外の失敗はエラーとして残す", async () => {
    let n = 0;
    const statuses = [500, 403, 404];
    mockDiscord((c) => (c.method === "POST" && n < statuses.length ? new Response("{}", { status: statuses[n++]! }) : {}));
    for (let i = 0; i < DAY_REMINDER_MAX_PER_RUN + 1; i++) await fixedPoll(jst("2026-11-06T21:00") + i);
    await remindAt("2026-11-06T17:00");
    expect(logged(log)).toContainEqual({ event: "day_reminder", sent: DAY_REMINDER_MAX_PER_RUN - 3, deferred: true, failed: 3 });
    const failures = logged(err).filter((e) => e.event === "day_reminder_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toContain("Discord API 500");
  });

  it("上限ちょうどなら残りなし。同じ回が重なっても 2 回は送らない", async () => {
    const calls = mockDiscord();
    for (let i = 0; i < DAY_REMINDER_MAX_PER_RUN; i++) await fixedPoll(jst("2026-11-06T21:00") + i);
    await Promise.all([remindAt("2026-11-06T17:00"), remindAt("2026-11-06T17:00")]);
    expect(posts(calls)).toHaveLength(DAY_REMINDER_MAX_PER_RUN);
    const runs = logged(log).filter((e) => e.event === "day_reminder");
    expect(runs.every((r) => r.deferred === false)).toBe(true);
    expect(runs.reduce((a, r) => a + (r.sent as number), 0)).toBe(DAY_REMINDER_MAX_PER_RUN);
  });
});
