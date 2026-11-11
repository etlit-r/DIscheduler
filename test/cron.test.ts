import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { runCron } from "../src/jobs/cron";
import { ALICE, GUILD, mockDiscord, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

describe("Cron（1 日 2 回）", () => {
  it("締切を過ぎた調整を closed にし、その調整と未反映の回答がある調整の募集メッセージだけ更新する", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    const overdue = await seedPoll({ deadlineAt: 1000 });
    const pending = await seedPoll();
    const synced = await seedPoll();
    const now = Math.floor(Date.now() / 1000);
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id IN (?, ?, ?)").bind(now - 100, overdue.pollId, pending.pollId, synced.pollId).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(pending.pollId, pending.slotIds[0], ALICE, pending.choiceIds[0], now).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(synced.pollId, synced.slotIds[0], ALICE, synced.choiceIds[0], now - 200).run();

    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));

    const st = await db().prepare("SELECT status FROM polls WHERE id = ?").bind(overdue.pollId).first<{ status: string }>();
    expect(st!.status).toBe("closed");
    // 締切を過ぎて closed にした調整と、未反映の回答がある調整の 2 件だけ（反映済みの調整は更新しない）
    const patched = calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/")).length;
    expect(patched).toBe(2);
  });

  it("日本時間 1 時の回だけ、期限切れのデータを削除する", async () => {
    mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    const old = await seedPoll();
    await db().prepare("UPDATE polls SET purge_after = 1 WHERE id = ?").bind(old.pollId).run();
    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(old.pollId).first()).not.toBeNull();
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(old.pollId).first()).toBeNull();
  });

  it("Bot が外されたサーバーのデータを削除する", async () => {
    mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [] : {}));
    const s = await seedPoll();
    await db().prepare("INSERT OR REPLACE INTO guild_recent_times (guild_id, ranges, updated_at) VALUES (?, '[]', ?)").bind(GUILD, Math.floor(Date.now() / 1000)).run();
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(s.pollId).first()).toBeNull();
    expect(await db().prepare("SELECT guild_id FROM guild_recent_times WHERE guild_id = ?").bind(GUILD).first()).toBeNull();
  });

  it("最近使った時間帯は、最後に使ってから 6 ヶ月たったら削除する", async () => {
    mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }, { id: "200000000000000777" }] : {}));
    const at = Math.floor(Date.now() / 1000);
    await db().batch([
      db().prepare("INSERT OR REPLACE INTO guild_recent_times (guild_id, ranges, updated_at) VALUES (?, '[]', ?)").bind(GUILD, at - 179 * 86400),
      db().prepare("INSERT OR REPLACE INTO guild_recent_times (guild_id, ranges, updated_at) VALUES (?, '[]', ?)").bind("200000000000000777", at - 181 * 86400),
    ]);
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(await db().prepare("SELECT guild_id FROM guild_recent_times WHERE guild_id = ?").bind(GUILD).first()).not.toBeNull();
    expect(await db().prepare("SELECT guild_id FROM guild_recent_times WHERE guild_id = ?").bind("200000000000000777").first()).toBeNull();
  });

  it("サーバーの一覧を最後まで読めなかったときは、何も削除しない", async () => {
    // 毎回 200 件を返し続ける（上限まで読んでも終わらない）
    let n = 0;
    mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? Array.from({ length: 200 }, () => ({ id: `8000000000${String(n++).padStart(8, "0")}` })) : {}));
    const s = await seedPoll();
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(s.pollId).first()).not.toBeNull();
  });

  it("締切を過ぎて closed にした調整は、回答の変更がなくても募集メッセージを更新する", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    const s = await seedPoll({ deadlineAt: 1000 });
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), s.pollId).run();
    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));
    const patch = calls.find((c) => c.method === "PATCH" && c.path.startsWith("/channels/"));
    expect(patch).toBeTruthy();
    expect(JSON.stringify(patch!.body)).toContain("締切を過ぎました");
  });

  it("1 回に更新する募集メッセージの数を、D1 の問い合わせ上限に収まるよう制限する", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 12; i++) {
      const p = await seedPoll();
      await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(now - 100, p.pollId).run();
      await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(p.pollId, p.slotIds[0], ALICE, p.choiceIds[0], now).run();
    }
    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/")).length).toBe(8);
    calls.length = 0;
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/")).length).toBe(4);
  });
});


describe("サーバーの数の通知（§14）", () => {
  const WEBHOOK = "https://discord.com/api/webhooks/900000000000000001/abcdefghijklmnopqrstuvwxyz0123456789";
  const guildList = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(100000000000000000n + BigInt(i)) }));

  it("75 を超えたら Webhook に 1 回だけ通知する", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? guildList(76) : {}));
    await runCron(testEnv({ ALERT_WEBHOOK_URL: WEBHOOK }), Date.parse("2026-11-06T16:00:00Z"));
    await runCron(testEnv({ ALERT_WEBHOOK_URL: WEBHOOK }), Date.parse("2026-11-07T16:00:00Z"));
    const posts = calls.filter((c) => c.method === "POST" && c.path.startsWith("/webhooks/900000000000000001/"));
    expect(posts.length).toBe(1);
    expect(JSON.stringify(posts[0]!.body)).toContain("76");
  });

  it("75 以下なら通知せず、75 以下に戻ったら次に超えたときにまた通知する", async () => {
    let n = 75;
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? guildList(n) : {}));
    const run = () => runCron(testEnv({ ALERT_WEBHOOK_URL: WEBHOOK }), Date.parse("2026-11-06T16:00:00Z"));
    const count = () => calls.filter((c) => c.path.startsWith("/webhooks/")).length;
    await run();
    expect(count()).toBe(0);
    n = 76;
    await run();
    expect(count()).toBe(1);
    n = 74;
    await run();
    n = 77;
    await run();
    expect(count()).toBe(2);
  });

  it("13 時の回では数えない", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? guildList(101) : {}));
    await runCron(testEnv({ ALERT_WEBHOOK_URL: WEBHOOK }), Date.parse("2026-11-06T04:00:00Z"));
    expect(calls.some((c) => c.path.startsWith("/webhooks/"))).toBe(false);
  });

  it("Webhook の URL がなければ通知しない（ほかの処理は続ける）", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? guildList(101) : {}));
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(calls.some((c) => c.path.startsWith("/webhooks/"))).toBe(false);
  });
});
