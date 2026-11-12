// プロジェクト全体のレビューで見つかった問題の修正
// （リマインドのメンションの分割・投稿の失敗、確定のお知らせの回数、参加の上限、Cron の締切後の更新）
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { handleInteraction } from "../src/discord/interactions";
import { runCron } from "../src/jobs/cron";
import { CHANNEL, errorOf, GUILD, jsonReq, call, login, member, mockDiscord, ORGANIZER, ORIGIN, pollRow, seedPoll, testEnv, type DiscordCall } from "./helpers";

const db = () => (env as unknown as Env).DB;
const ids = (n: number, base = 600000000000000000n) => Array.from({ length: n }, (_, i) => String(base + BigInt(i)));
const posts = (calls: DiscordCall[]) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`);
afterEach(() => vi.restoreAllMocks());

async function organizer(opts: Parameters<typeof seedPoll>[0], handler?: (c: DiscordCall) => unknown) {
  const calls = mockDiscord(handler);
  const s = await seedPoll(opts);
  const auth = await login(s.pollId, ORGANIZER, "organizer", "edit");
  return { ...s, calls, req: (method: string, path: string, body?: unknown) => call(jsonReq(method, `/api/polls/${s.pollId}${path}`, body, auth)) };
}

describe("回答のリマインド", () => {
  it("未回答の人が多いときは、メンションを途中で切らずに複数のメッセージに分け、［回答する］は最後に付ける", async () => {
    const people = ids(90);
    const t = await organizer({ participants: people });
    expect(await (await t.req("POST", "/remind")).json()).toEqual({ ok: true, count: 90 });
    const sent = posts(t.calls).map((c) => c.body as { content: string; allowed_mentions: { users: string[] }; components: unknown[] });
    expect(sent).toHaveLength(2);
    expect(sent.flatMap((m) => m.allowed_mentions.users)).toEqual(people);
    for (const m of sent) {
      expect(m.content.length).toBeLessThanOrEqual(2000);
      expect(m.content.match(/<@\d+>/g)).toHaveLength(m.allowed_mentions.users.length);
    }
    expect(sent[0]!.components).toEqual([]);
    expect(JSON.stringify(sent[1]!.components)).toContain(`"custom_id":"answer:${t.pollId}"`);
  });

  it("1 通も投稿できなければ 502 にし、すぐにやり直せる", async () => {
    let fail = true;
    const t = await organizer({}, (c) => (c.method === "POST" && fail ? new Response("{}", { status: 403 }) : {}));
    expect((await errorOf(await t.req("POST", "/remind"))).code).toBe("discord_failed");
    expect((await pollRow(t.pollId))!.last_reminded_at).toBeNull();
    fail = false;
    expect(await (await t.req("POST", "/remind")).json()).toEqual({ ok: true, count: 3 });
  });

  it("前に送ったリマインドの時刻も、失敗したら元に戻す", async () => {
    const t = await organizer({}, (c) => (c.method === "POST" ? new Response("{}", { status: 500 }) : {}));
    const before = Math.floor(Date.now() / 1000) - 13 * 3600;
    await db().prepare("UPDATE polls SET last_reminded_at = ? WHERE id = ?").bind(before, t.pollId).run();
    expect((await t.req("POST", "/remind")).status).toBe(502);
    expect((await pollRow(t.pollId))!.last_reminded_at).toBe(before);
  });

  it("一部を送れたあとに失敗したら、同じ人に重ねて送らないよう、12 時間の制限は残す", async () => {
    let n = 0;
    const t = await organizer({ participants: ids(90) }, (c) => (c.method === "POST" && n++ > 0 ? new Response("{}", { status: 500 }) : {}));
    expect((await t.req("POST", "/remind")).status).toBe(502);
    expect((await pollRow(t.pollId))!.last_reminded_at).not.toBeNull();
    expect((await errorOf(await t.req("POST", "/remind"))).code).toBe("rate_limited");
  });
});

describe("確定のお知らせ", () => {
  it("投稿に失敗した回は、1 時間 10 回の制限に数えない", async () => {
    let fail = true;
    const t = await organizer({ status: "fixed" }, (c) => (c.method === "POST" && fail ? new Response("{}", { status: 500 }) : {}));
    await db().prepare("UPDATE slots SET fixed_at = 1 WHERE id = ?").bind(t.slotIds[0]).run();
    for (let i = 0; i < 10; i++) expect((await t.req("POST", "/announce", { mention: false })).status).toBe(502);
    fail = false;
    expect((await t.req("POST", "/announce", { mention: false })).status).toBe(200);
  });
});

describe("参加を受け付ける調整への参加", () => {
  type Interaction = Parameters<typeof handleInteraction>[2];
  /** ［回答する］を押す（Discord への通信の差し替えは、呼ぶ側で済ませておく） */
  async function pressRaw(pollId: string, user: string) {
    const pending: Promise<unknown>[] = [];
    await handleInteraction(
      testEnv(),
      { waitUntil: (p) => void pending.push(p) },
      { id: "9", application_id: "100000000000000001", token: "tok", type: 3, guild_id: GUILD, channel_id: CHANNEL, member: member(user), data: { custom_id: `answer:${pollId}` } } as unknown as Interaction,
      ORIGIN,
    );
    await Promise.all(pending);
  }
  async function press(pollId: string, user: string) {
    const calls = mockDiscord();
    await pressRaw(pollId, user);
    vi.mocked(globalThis.fetch).mockRestore();
    const edit = calls.find((c) => c.path.endsWith("/messages/@original"))!.body as { content: string };
    return { calls, content: edit.content };
  }
  const count = async (pollId: string) => (await db().prepare("SELECT COUNT(*) AS n FROM participants WHERE poll_id = ?").bind(pollId).first<{ n: number }>())!.n;

  it("参加者が 100 人に達していれば参加できない。99 人なら参加できる", async () => {
    const full = await seedPoll({ joinPolicy: "open", participants: ids(100) });
    const r = await press(full.pollId, "400000000000000077");
    expect(r.content).toBe("この調整の参加者が上限（100 人）に達しているため、参加できません。主催者に連絡してください。");
    expect(await count(full.pollId)).toBe(100);

    const almost = await seedPoll({ joinPolicy: "open", participants: ids(99) });
    expect((await press(almost.pollId, "400000000000000077")).content).toContain("あなた専用のリンクです");
    expect(await count(almost.pollId)).toBe(100);
  });

  it("同時に押されても、上限を超えない", async () => {
    const p = await seedPoll({ joinPolicy: "open", participants: ids(99) });
    mockDiscord();
    await Promise.all([pressRaw(p.pollId, "400000000000000071"), pressRaw(p.pollId, "400000000000000072")]);
    expect(await count(p.pollId)).toBe(100);
  });

  it("参加したら募集メッセージを更新する。すでに参加者なら更新しない", async () => {
    const p = await seedPoll({ joinPolicy: "open" });
    const joined = await press(p.pollId, "400000000000000078");
    expect(joined.calls.some((c) => c.method === "PATCH" && c.path === `/channels/${CHANNEL}/messages/500000000000000001`)).toBe(true);
    await db().prepare("UPDATE polls SET last_synced_at = NULL WHERE id = ?").bind(p.pollId).run();
    const again = await press(p.pollId, "400000000000000078");
    expect(again.calls.some((c) => c.path.startsWith("/channels/"))).toBe(false);
  });
});

describe("Cron の締切後の更新", () => {
  beforeEach(async () => {
    await db().prepare("DELETE FROM polls").run();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("一度に締め切った調整が上限を超えたら、残りは次の回に「締切を過ぎました」に更新する", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    for (let i = 0; i < 10; i++) {
      const p = await seedPoll({ deadlineAt: 1000 });
      // 締切の前に一度更新済み（未反映の回答はない）
      await db().prepare("UPDATE polls SET last_synced_at = 500 WHERE id = ?").bind(p.pollId).run();
    }
    const noon = Date.parse("2026-11-06T04:00:00Z");
    const patched = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/")).length;
    await runCron(testEnv(), noon);
    expect(patched()).toBe(8);
    await runCron(testEnv(), noon);
    expect(patched()).toBe(10);
    // 全部更新したら、それ以上は更新しない
    await runCron(testEnv(), noon);
    expect(patched()).toBe(10);
  });

  it("締切のあとに更新済みなら、締め切った調整でも更新し直さない", async () => {
    const calls = mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    const p = await seedPoll({ status: "closed", deadlineAt: 1000 });
    await db().prepare("UPDATE polls SET last_synced_at = 1000 WHERE id = ?").bind(p.pollId).run();
    await runCron(testEnv(), Date.parse("2026-11-06T04:00:00Z"));
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });
});
