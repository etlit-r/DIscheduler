// Discord REST API クライアントと参加者の自動抽出（Stryker で検出できなかったミュータントへの対策）
import { afterEach, describe, expect, it, vi } from "vitest";
import { discord, DiscordError, memberDisplayName, redactPath } from "../src/discord/rest";
import { canViewChannel, extractParticipants, fetchMember, searchMembers } from "../src/discord/members";
import { PERM } from "../src/discord/permissions";
import { CHANNEL, GUILD, mockDiscord, testEnv } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function mockFetch(responses: (() => Response)[]): Sent[] {
  const sent: Sent[] = [];
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    const r = responses[Math.min(n, responses.length - 1)]!;
    n++;
    return r();
  });
  return sent;
}
const ok = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("REST API クライアント", () => {
  it("Bot のトークンと User-Agent を付け、本文があれば JSON で送る", async () => {
    const sent = mockFetch([ok({ a: 1 })]);
    expect(await discord(testEnv(), "POST", "/x", { b: 2 }, { reason: "理由 あ" })).toEqual({ a: 1 });
    expect(sent[0]).toEqual({
      url: "https://discord.test/api/v10/x",
      method: "POST",
      headers: {
        "User-Agent": "DiscordBot (https://github.com/etlit-r/DIscheduler, 1.0)",
        Authorization: "Bot test-bot-token",
        "Content-Type": "application/json",
        "X-Audit-Log-Reason": encodeURIComponent("理由 あ"),
      },
      body: '{"b":2}',
    });
  });

  it("auth: none ならトークンを付けない。本文がなければ Content-Type も付けない", async () => {
    const sent = mockFetch([ok([])]);
    await discord(testEnv(), "GET", "/y", undefined, { auth: "none" });
    expect(sent[0]!.headers).toEqual({ "User-Agent": "DiscordBot (https://github.com/etlit-r/DIscheduler, 1.0)" });
    expect(sent[0]!.body).toBeUndefined();
  });

  it("API の URL の既定は discord.com", async () => {
    const sent = mockFetch([ok({})]);
    await discord(testEnv({ DISCORD_API_BASE: undefined }), "GET", "/z");
    expect(sent[0]!.url).toBe("https://discord.com/api/v10/z");
  });

  it("204 なら undefined を返す", async () => {
    mockFetch([() => new Response(null, { status: 204 })]);
    expect(await discord(testEnv(), "DELETE", "/z")).toBeUndefined();
  });

  it("エラーは状態コードと本文（500 文字まで）を持つ", async () => {
    mockFetch([() => new Response("e".repeat(600), { status: 403 })]);
    const err = (await discord(testEnv(), "GET", "/z").catch((e) => e)) as DiscordError;
    expect(err).toBeInstanceOf(DiscordError);
    expect(err.status).toBe(403);
    expect(err.body).toHaveLength(500);
    expect(err.message).toBe("Discord API 403 /z");
  });

  it("429 なら retry_after 秒待って 1 回だけやり直す（0〜5 秒）", async () => {
    vi.useFakeTimers();
    const sent = mockFetch([ok({ retry_after: 2 }, 429), ok({ done: true })]);
    const p = discord(testEnv(), "GET", "/r");
    await vi.advanceTimersByTimeAsync(1999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ done: true });
    expect(sent).toHaveLength(2);
  });

  it("429 の待ち時間は 5 秒まで。retry_after がなければ 1 秒、負なら 0 秒", async () => {
    vi.useFakeTimers();
    for (const [body, ms] of [[{ retry_after: 60 }, 5000], [{}, 1000], [{ retry_after: -3 }, 0]] as const) {
      const sent = mockFetch([ok(body, 429), ok({})]);
      const p = discord(testEnv(), "GET", "/r");
      if (ms > 0) {
        await vi.advanceTimersByTimeAsync(ms - 1);
        expect(sent, JSON.stringify(body)).toHaveLength(1);
      }
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(sent).toHaveLength(2);
      vi.restoreAllMocks();
    }
  });

  it("429 の本文が JSON でなくても 1 秒待つ。2 回続けば 429 のエラー", async () => {
    vi.useFakeTimers();
    const sent = mockFetch([() => new Response("x", { status: 429 })]);
    const p = discord(testEnv(), "GET", "/r").catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = (await p) as DiscordError;
    expect(sent).toHaveLength(2);
    expect(err).toBeInstanceOf(DiscordError);
    expect(err.status).toBe(429);
  });

  it("URL の Interaction トークンを伏せる", () => {
    expect(redactPath("/webhooks/1/abc?x=1")).toBe("/webhooks/1/[redacted]?x=1");
    expect(redactPath("/x/webhooks/1/abc")).toBe("/x/webhooks/1/abc");
    expect(new DiscordError(404, "", "/webhooks/1/abc/messages/@original").path).toBe("/webhooks/1/[redacted]/messages/@original");
  });

  it("表示名はニックネーム → 表示名 → ユーザー名の順", () => {
    const u = { id: "1", username: "user", global_name: "global" };
    expect(memberDisplayName({ roles: [], nick: "nick", user: u })).toBe("nick");
    expect(memberDisplayName({ roles: [], nick: "", user: u })).toBe("global");
    expect(memberDisplayName({ roles: [], user: { ...u, global_name: null } })).toBe("user");
    expect(memberDisplayName({ roles: [], user: { id: "1", username: "" } })).toBe("（名前なし）");
    expect(memberDisplayName({ roles: [] })).toBe("（名前なし）");
  });
});

const m = (id: string, roles: string[] = [], extra: Record<string, unknown> = {}) => ({ user: { id, username: `u${id}`, ...extra }, roles });

describe("チャンネルの閲覧権限", () => {
  const VIEW = String(PERM.VIEW_CHANNEL);
  const roles = new Map([
    [GUILD, { id: GUILD, name: "@everyone", permissions: "0", position: 0 }],
    ["r1", { id: "r1", name: "r1", permissions: VIEW, position: 1 }],
    ["adm", { id: "adm", name: "adm", permissions: String(PERM.ADMINISTRATOR), position: 2 }],
  ]);
  const ch = (overwrites: { id: string; type: 0 | 1; allow: string; deny: string }[] = []) => ({ id: "c", type: 0, permission_overwrites: overwrites });

  it("ユーザーがない・権限がなければ見られない。ロールの権限があれば見られる", () => {
    expect(canViewChannel({ roles: [] }, GUILD, "o", roles, ch())).toBe(false);
    expect(canViewChannel(m("1"), GUILD, "o", roles, ch())).toBe(false);
    expect(canViewChannel(m("1", ["r1"]), GUILD, "o", roles, ch())).toBe(true);
    expect(canViewChannel(m("1", ["missing"]), GUILD, "o", roles, { id: "c", type: 0 })).toBe(false);
  });

  it("管理者とサーバーの所有者は、拒否されていても見られる", () => {
    const deny = ch([{ id: "1", type: 1, allow: "0", deny: VIEW }]);
    expect(canViewChannel(m("1", ["adm"]), GUILD, "o", roles, deny)).toBe(true);
    expect(canViewChannel(m("1"), GUILD, "1", roles, deny)).toBe(true);
  });

  it("@everyone の許可、ロールの拒否、メンバー個別の許可の順に重ねる", () => {
    expect(canViewChannel(m("1"), GUILD, "o", roles, ch([{ id: GUILD, type: 0, allow: VIEW, deny: "0" }]))).toBe(true);
    expect(canViewChannel(m("1", ["r1"]), GUILD, "o", roles, ch([{ id: "r1", type: 0, allow: "0", deny: VIEW }]))).toBe(false);
    // 持っていないロールの上書きは関係ない
    expect(canViewChannel(m("1"), GUILD, "o", roles, ch([{ id: "r2", type: 0, allow: VIEW, deny: "0" }]))).toBe(false);
    // ロールと同じ ID のメンバー個別の上書きは、ロールとしては扱わない
    expect(canViewChannel(m("1", ["r1"]), GUILD, "o", roles, ch([{ id: "r1", type: 1, allow: "0", deny: VIEW }]))).toBe(true);
    expect(
      canViewChannel(m("1", ["r1"]), GUILD, "o", roles, ch([
        { id: "r1", type: 0, allow: "0", deny: VIEW },
        { id: "1", type: 1, allow: VIEW, deny: "0" },
      ])),
    ).toBe(true);
    // 別のメンバーの個別の上書きは関係ない。個別の上書きは type 1 だけ
    expect(canViewChannel(m("1"), GUILD, "o", roles, ch([{ id: "2", type: 1, allow: VIEW, deny: "0" }]))).toBe(false);
    expect(canViewChannel(m("1"), GUILD, "o", roles, ch([{ id: "1", type: 0, allow: VIEW, deny: "0" }]))).toBe(false);
    // @everyone の拒否より、ロールの許可が優先
    expect(
      canViewChannel(m("1", ["r1"]), GUILD, "o", roles, ch([
        { id: GUILD, type: 0, allow: "0", deny: VIEW },
        { id: "r1", type: 0, allow: VIEW, deny: "0" },
      ])),
    ).toBe(true);
    // 許可と拒否が両方あるロールが複数あれば、許可が優先
    const roles2 = new Map([...roles, ["r2", { id: "r2", name: "r2", permissions: "0", position: 1 }]]);
    expect(
      canViewChannel(m("1", ["r1", "r2"]), GUILD, "o", roles2, ch([
        { id: "r1", type: 0, allow: "0", deny: VIEW },
        { id: "r2", type: 0, allow: VIEW, deny: "0" },
      ])),
    ).toBe(true);
  });
});

describe("参加者の自動抽出", () => {
  const guild = (handler: (path: string) => unknown) => mockDiscord((c) => handler(c.path));

  it("チャンネルを見られる人を、Bot を除いて表示名つきで返す", async () => {
    guild((p) => {
      if (p === `/channels/${CHANNEL}`) return { id: CHANNEL, type: 0, permission_overwrites: [{ id: "r1", type: 0, allow: String(PERM.VIEW_CHANNEL), deny: "0" }] };
      if (p === `/guilds/${GUILD}`) return { owner_id: "o" };
      if (p === `/guilds/${GUILD}/roles`) return [{ id: GUILD, name: "@everyone", permissions: "0", position: 0 }];
      if (p.startsWith(`/guilds/${GUILD}/members?limit=1000&after=0`)) return [m("1", ["r1"], { global_name: "表示‮名" }), m("2"), m("o"), m("b", ["r1"], { bot: true }), { roles: ["r1"] }];
      return {};
    });
    expect(await extractParticipants(testEnv(), GUILD, CHANNEL, null)).toEqual({
      ok: true,
      members: [
        { userId: "1", displayName: "表示名" },
        { userId: "o", displayName: "uo" },
      ],
    });
  });

  it("スレッドは親チャンネルの権限で決める。プライベートスレッドはスレッドのメンバー", async () => {
    const calls = guild((p) => {
      if (p === "/channels/t1") return { id: "t1", type: 11, parent_id: CHANNEL };
      if (p === `/channels/${CHANNEL}`) return { id: CHANNEL, type: 0, permission_overwrites: [] };
      if (p === `/guilds/${GUILD}`) return { owner_id: "o" };
      if (p === `/guilds/${GUILD}/roles`) return [{ id: GUILD, name: "@everyone", permissions: String(PERM.VIEW_CHANNEL), position: 0 }];
      if (p.startsWith(`/guilds/${GUILD}/members?`)) return [m("1")];
      if (p === "/channels/t2") return { id: "t2", type: 12, parent_id: CHANNEL };
      if (p === "/channels/t2/thread-members?with_member=true&limit=100") return [{ member: m("5") }, {}, { member: m("6", [], { bot: true }) }];
      if (p === "/channels/t3") return { id: "t3", type: 10, parent_id: null };
      return {};
    });
    expect(await extractParticipants(testEnv(), GUILD, "t1", null)).toEqual({ ok: true, members: [{ userId: "1", displayName: "u1" }] });
    expect(calls.map((c) => c.path)).toContain(`/channels/${CHANNEL}`);
    expect(await extractParticipants(testEnv(), GUILD, "t2", null)).toEqual({ ok: true, members: [{ userId: "5", displayName: "u5" }] });
    calls.length = 0;
    // 親のないスレッドは、そのスレッド自身の権限で決める
    expect((await extractParticipants(testEnv(), GUILD, "t3", null)).ok).toBe(true);
    expect(calls.map((c) => c.path)).not.toContain(`/channels/${CHANNEL}`);
  });

  it("ロールを指定したら、そのロールのメンバー。1000 人ごとにページを進める", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => m(String(1000 + i), i === 0 ? ["R"] : []));
    const calls = guild((p) => {
      if (p === `/guilds/${GUILD}/members?limit=1000&after=0`) return page1;
      if (p === `/guilds/${GUILD}/members?limit=1000&after=1999`) return [m("3000", ["R"]), m("3001")];
      return [];
    });
    const r = await extractParticipants(testEnv(), GUILD, CHANNEL, "R");
    expect(r).toEqual({ ok: true, members: [{ userId: "1000", displayName: "u1000" }, { userId: "3000", displayName: "u3000" }] });
    expect(calls).toHaveLength(2);
  });

  it("メンバーが 5000 人を超えたら諦める", async () => {
    let n = 0;
    const calls = guild(() => Array.from({ length: 1000 }, () => m(String(n++), ["R"])));
    const r = await extractParticipants(testEnv(), GUILD, CHANNEL, "R");
    expect(r).toMatchObject({ ok: false, reason: "too_many" });
    expect((r as { message: string }).message).toContain("サーバーのメンバーが多すぎる");
    expect(calls).toHaveLength(5);
  });

  it("チャンネルの抽出でも 5000 人を超えたら諦める", async () => {
    let n = 0;
    guild((p) => {
      if (p === `/channels/${CHANNEL}`) return { id: CHANNEL, type: 0 };
      if (p === `/guilds/${GUILD}`) return { owner_id: "o" };
      if (p === `/guilds/${GUILD}/roles`) return [];
      return Array.from({ length: 1000 }, () => m(String(n++)));
    });
    expect(await extractParticipants(testEnv(), GUILD, CHANNEL, null)).toMatchObject({ ok: false, reason: "too_many" });
  });

  it("100 人を超えたら自動では設定しない。100 人ちょうどなら設定する", async () => {
    guild(() => Array.from({ length: 101 }, (_, i) => m(String(i), ["R"])));
    const r = await extractParticipants(testEnv(), GUILD, CHANNEL, "R");
    expect(r).toMatchObject({ ok: false, reason: "too_many" });
    expect((r as { message: string }).message).toContain("参加者が 100 人を超えるため");
    vi.restoreAllMocks();
    guild(() => Array.from({ length: 100 }, (_, i) => m(String(i), ["R"])));
    expect((await extractParticipants(testEnv(), GUILD, CHANNEL, "R")).ok).toBe(true);
  });

  it("メンバー一覧の 403 は Intent が無効と案内する。ほかの失敗は一般的な案内", async () => {
    guild(() => new Response("{}", { status: 403 }));
    expect(await extractParticipants(testEnv(), GUILD, CHANNEL, "R")).toMatchObject({ ok: false, reason: "intent_disabled" });
    // メンバー一覧以外の 403
    expect(await extractParticipants(testEnv(), GUILD, CHANNEL, null)).toMatchObject({ ok: false, reason: "error" });
    vi.restoreAllMocks();
    guild(() => new Response("{}", { status: 500 }));
    const r = await extractParticipants(testEnv(), GUILD, CHANNEL, "R");
    expect(r).toEqual({ ok: false, reason: "error", message: "参加者を自動で設定できませんでした。手動で参加者を選んでください。" });
  });

  it("1 人の取得: Bot・見つからない人は null、ほかの失敗は投げる", async () => {
    guild((p) => (p.endsWith("/1") ? m("1", [], { global_name: "名前" }) : p.endsWith("/2") ? m("2", [], { bot: true }) : p.endsWith("/3") ? { roles: [] } : new Response("{}", { status: p.endsWith("/4") ? 404 : 500 })));
    expect(await fetchMember(testEnv(), GUILD, "1")).toEqual({ userId: "1", displayName: "名前" });
    expect(await fetchMember(testEnv(), GUILD, "2")).toBeNull();
    expect(await fetchMember(testEnv(), GUILD, "3")).toBeNull();
    expect(await fetchMember(testEnv(), GUILD, "4")).toBeNull();
    await expect(fetchMember(testEnv(), GUILD, "5")).rejects.toBeInstanceOf(DiscordError);
  });

  it("検索語は 32 文字までにして URL エンコードする", async () => {
    const calls = guild(() => [m("1"), m("2", [], { bot: true })]);
    expect(await searchMembers(testEnv(), GUILD, "a b&" + "x".repeat(40))).toEqual([{ userId: "1", displayName: "u1" }]);
    expect(calls[0]!.path).toBe(`/guilds/${GUILD}/members/search?query=${encodeURIComponent("a b&" + "x".repeat(28))}&limit=25`);
  });
});
