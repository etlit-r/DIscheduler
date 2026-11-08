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
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect(await db().prepare("SELECT id FROM polls WHERE id = ?").bind(s.pollId).first()).toBeNull();
  });

  it("サーバーの一覧を最後まで読めなかったときは、何も削除しない", async () => {
    // 毎回 200 件を返し続ける（上限まで読んでも終わらない）
    let n = 0;
    mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? Array.from({ length: 200 }, () => ({ id: String(800000000000000000 + n++) })) : {}));
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

