import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { ALICE, call, CHANNEL, GUILD, mockDiscord, ORGANIZER, ORIGIN, OUTSIDER, seedPoll, testEnv } from "./helpers";

let keys: CryptoKeyPair;
let publicHex: string;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  publicHex = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
});
afterEach(() => vi.restoreAllMocks());

async function signed(body: unknown, opts: { tamper?: boolean; ts?: number } = {}): Promise<Request> {
  const text = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + text)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(`${ORIGIN}/discord/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature-Ed25519": hex, "X-Signature-Timestamp": ts },
    body: opts.tamper ? text.replace("1", "2") : text,
  });
}

const e = () => testEnv({ DISCORD_PUBLIC_KEY: publicHex });
const member = (id: string, permissions = "1024") => ({ user: { id, username: `u${id.slice(-2)}` }, roles: [], permissions });

describe("署名検証（security-design S-1）", () => {
  it("正しい署名の PING に応答する", async () => {
    mockDiscord();
    const res = await call(await signed({ type: 1, id: "1", application_id: "1", token: "t" }), e());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("改ざんされた本文は 401", async () => {
    const res = await call(await signed({ type: 1, id: "1", application_id: "1", token: "t" }, { tamper: true }), e());
    expect(res.status).toBe(401);
  });

  it("5 分より古い署名は 401（リプレイ対策）", async () => {
    const res = await call(await signed({ type: 1 }, { ts: Math.floor(Date.now() / 1000) - 400 }), e());
    expect(res.status).toBe(401);
  });

  it("署名がなければ 401", async () => {
    const res = await call(new Request(`${ORIGIN}/discord/interactions`, { method: "POST", body: "{}" }), e());
    expect(res.status).toBe(401);
  });
});

describe("/schedule と /poll", () => {
  for (const name of ["schedule", "poll"]) {
    it(`/${name} だけで下書きを作り、本人にだけ見えるリンクを返す`, async () => {
      const calls = mockDiscord((c) => {
        if (c.path === `/channels/${CHANNEL}`) return { id: CHANNEL, type: 0, permission_overwrites: [] };
        if (c.path === `/guilds/${GUILD}`) return { owner_id: ORGANIZER };
        if (c.path === `/guilds/${GUILD}/roles`) return [{ id: GUILD, name: "@everyone", permissions: "1024", position: 0 }];
        if (c.path.startsWith(`/guilds/${GUILD}/members?`)) return [member(ORGANIZER), member(ALICE), { user: { id: "1", username: "bot", bot: true }, roles: [] }];
        return {};
      });
      const res = await call(
        await signed({ type: 2, id: "9", application_id: "100000000000000001", token: "tok", guild_id: GUILD, channel_id: CHANNEL, member: member(ORGANIZER), data: { name } }),
        e(),
      );
      expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
      const edit = calls.find((c) => c.method === "PATCH" && c.path.includes("/messages/@original"))!;
      expect(edit).toBeTruthy();
      const json = JSON.stringify(edit.body);
      expect(json).toContain("/l#t=");
      expect(json).toContain("調整を作成する");
      const db = (env as unknown as Env).DB;
      const poll = await db.prepare("SELECT id, status, title FROM polls WHERE organizer_id = ? AND channel_id = ? AND status = 'draft'").bind(ORGANIZER, CHANNEL).first<{ id: string; title: string | null }>();
      expect(poll!.title).toBeNull();
      const ps = await db.prepare("SELECT user_id FROM participants WHERE poll_id = ?").bind(poll!.id).all<{ user_id: string }>();
      expect(ps.results.map((p) => p.user_id).sort()).toEqual([ORGANIZER, ALICE].sort()); // Bot は除外
    });
  }

  it("未入力の下書きは使い回す", async () => {
    mockDiscord((c) => {
      if (c.path === `/channels/${CHANNEL}`) return { id: CHANNEL, type: 0, permission_overwrites: [] };
      if (c.path === `/guilds/${GUILD}`) return { owner_id: ORGANIZER };
      if (c.path === `/guilds/${GUILD}/roles`) return [{ id: GUILD, name: "@everyone", permissions: "1024", position: 0 }];
      if (c.path.startsWith(`/guilds/${GUILD}/members?`)) return [member(ORGANIZER)];
      return {};
    });
    const cmd = async () =>
      call(await signed({ type: 2, id: "9", application_id: "100000000000000001", token: "tok", guild_id: GUILD, channel_id: CHANNEL, member: member(ORGANIZER), data: { name: "schedule" } }), e());
    await cmd();
    await cmd();
    await cmd();
    const n = await (env as unknown as Env).DB.prepare("SELECT COUNT(*) AS n FROM polls WHERE organizer_id = ? AND status = 'draft'").bind(ORGANIZER).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});

describe("募集メッセージのボタン", () => {
  it("参加者でない人にはリンクを発行しない", async () => {
    const s = await seedPoll();
    const calls = mockDiscord();
    await call(
      await signed({ type: 3, id: "9", application_id: "1", token: "tok", guild_id: GUILD, channel_id: CHANNEL, member: member(OUTSIDER), data: { custom_id: `answer:${s.pollId}` } }),
      e(),
    );
    const edit = calls.find((c) => c.path.includes("/messages/@original"))!;
    expect(JSON.stringify(edit.body)).not.toContain("/l#t=");
  });

  it("別のチャンネルから押された custom_id は拒否する", async () => {
    const s = await seedPoll();
    const calls = mockDiscord();
    await call(
      await signed({ type: 3, id: "9", application_id: "1", token: "tok", guild_id: GUILD, channel_id: "399999999999999999", member: member(ALICE), data: { custom_id: `answer:${s.pollId}` } }),
      e(),
    );
    expect(JSON.stringify(calls.find((c) => c.path.includes("/messages/@original"))!.body)).not.toContain("/l#t=");
  });

  it("参加者には本人専用のリンクを発行する", async () => {
    const s = await seedPoll();
    const calls = mockDiscord();
    await call(
      await signed({ type: 3, id: "9", application_id: "1", token: "tok", guild_id: GUILD, channel_id: CHANNEL, member: member(ALICE), data: { custom_id: `answer:${s.pollId}` } }),
      e(),
    );
    expect(JSON.stringify(calls.find((c) => c.path.includes("/messages/@original"))!.body)).toContain("/l#t=");
  });

  it("join_policy=open なら、チャンネルを見られる人を参加者に追加する", async () => {
    const s = await seedPoll({ joinPolicy: "open" });
    const calls = mockDiscord();
    await call(
      await signed({ type: 3, id: "9", application_id: "1", token: "tok", guild_id: GUILD, channel_id: CHANNEL, member: member(OUTSIDER, "1024"), data: { custom_id: `answer:${s.pollId}` } }),
      e(),
    );
    expect(JSON.stringify(calls.find((c) => c.path.includes("/messages/@original"))!.body)).toContain("/l#t=");
  });
});
