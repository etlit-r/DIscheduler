import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { ERROR_LOG_HOURLY_MAX, errorSummary, logError } from "../src/core/log";
import { DiscordError } from "../src/discord/rest";
import { runCron } from "../src/jobs/cron";
import { syncNow } from "../src/polls/sync";
import { ALICE, call, GUILD, getReq, jsonReq, login, mockDiscord, ORGANIZER, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
type Row = { event: string; ref: string | null; poll_id: string | null; message: string; at: number };
const rows = async () => (await db().prepare("SELECT event, ref, poll_id, message, at FROM error_logs ORDER BY id").all<Row>()).results;
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await db().prepare("DELETE FROM error_logs").run();
});

describe("エラーの要約を D1 に残す（§12）", () => {
  it("種類・参照番号・調整・エラーの文を残す。制御文字は除き、300 文字までにする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await logError(testEnv(), "unhandled_error", new Error(`bad\nline${"x".repeat(400)}`), { ref: "abc123", pollId: "AAAAAAAAAAAAAAAAAAAAAA" });
    const [r] = await rows();
    expect(r).toMatchObject({ event: "unhandled_error", ref: "abc123", poll_id: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(r!.message).not.toContain("\n");
    expect(r!.message.length).toBe(300);
    expect(errorSummary("text")).toBe("text");
    expect(errorSummary(42)).toBe("unknown");
  });

  it("Discord の API のアドレスのトークンは伏せたまま残す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = new DiscordError(500, "body", "/webhooks/123456789012345678/secret-token-value-123456/messages/@original");
    await logError(testEnv(), "interaction_error", e);
    const [r] = await rows();
    expect(r!.message).not.toContain("secret-token-value");
  });

  it("1 時間に決まった件数までしか残さない（エラーが続いても書き込みが増えすぎないように）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1000);
    const ins = db().prepare("INSERT INTO error_logs (at, event, message) VALUES (?, 'x', 'x')");
    await db().batch(Array.from({ length: ERROR_LOG_HOURLY_MAX }, () => ins.bind(now)));
    await logError(testEnv(), "unhandled_error", new Error("over"));
    expect((await rows()).length).toBe(ERROR_LOG_HOURLY_MAX);
  });

  it("D1 に書けなくても、元の処理は止めない", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { DB: { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database };
    await expect(logError(broken, "unhandled_error", new Error("x"))).resolves.toBeUndefined();
    expect(errors.mock.calls.some((c) => String(c[0]).includes("error_log_failed"))).toBe(true);
  });

  it("募集メッセージの更新に失敗したら、調整の ID と一緒に残す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockDiscord(() => new Response("{}", { status: 500 }));
    const s = await seedPoll();
    await syncNow(testEnv(), s.pollId);
    const r = (await rows()).find((x) => x.event === "sync_failed");
    expect(r?.poll_id).toBe(s.pollId);
    expect(r?.message).toContain("Discord API 500");
  });

  it("募集メッセージが消されていた（404）ときは、エラーの記録には残さない", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockDiscord(() => new Response("{}", { status: 404 }));
    const s = await seedPoll();
    await syncNow(testEnv(), s.pollId);
    expect((await rows()).length).toBe(0);
  });

  it("API の予期しないエラーは、画面に出す参照番号と一緒に残す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    // 調整の読み込みで D1 が失敗する状態を作る（エラーの記録の書き込みはそのまま通す）
    const real = db();
    const e = testEnv({
      DB: new Proxy(real, {
        get: (t, p) => (p === "prepare" ? (sql: string) => { if (!sql.includes("error_logs") && !sql.includes("sessions")) throw new Error("boom"); return t.prepare(sql); } : Reflect.get(t, p).bind?.(t) ?? Reflect.get(t, p)),
      }),
    });
    const res = await call(getReq(`/api/polls/${s.pollId}`, org.cookie), e);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    const ref = /参照番号: ([A-Za-z0-9_-]+)/.exec(body.error.message)?.[1];
    const r = (await rows()).find((x) => x.event === "unhandled_error");
    expect(r?.ref).toBe(ref);
  });

  it("7 日たった記録は、日本時間 1 時の Cron で消す", async () => {
    mockDiscord((c) => (c.path.startsWith("/users/@me/guilds") ? [{ id: GUILD }] : {}));
    const at = Math.floor(Date.now() / 1000);
    await db().batch([
      db().prepare("INSERT INTO error_logs (at, event, message) VALUES (?, 'old', 'x')").bind(at - 8 * 86400),
      db().prepare("INSERT INTO error_logs (at, event, message) VALUES (?, 'new', 'x')").bind(at - 6 * 86400),
    ]);
    await runCron(testEnv(), Date.parse("2026-11-06T16:00:00Z"));
    expect((await rows()).map((r) => r.event)).toEqual(["new"]);
  });
});

describe("画面で受け取った、DIscheduler の JSON でない失敗の知らせ（§12）", () => {
  beforeEach(async () => {
    await db().prepare("DELETE FROM rate_limits WHERE key LIKE 'client-error:%'").run();
  });
  const report = { status: 503, method: "PUT", path: "/api/polls/:id/slots", at: 1795000000, ray: "8e1f2a3b4c5d6e7f-NRT" };

  it("状態コード・操作・時刻・Ray ID を、調整の ID と一緒に残す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("POST", `/api/polls/${s.pollId}/client-errors`, report, org));
    expect(res.status).toBe(200);
    const [r] = await rows();
    expect(r).toMatchObject({ event: "client_http_error", poll_id: s.pollId });
    expect(r!.message).toBe("PUT /api/polls/:id/slots HTTP 503 at 2026-11-18T11:06:40.000Z ray 8e1f2a3b4c5d6e7f-NRT");
  });

  it("参加者のセッションでも残せる。セッションと CSRF のトークンがなければ断る", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await seedPoll({ participants: [ALICE] });
    const alice = await login(s.pollId, ALICE, "participant");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/client-errors`, report, alice))).status).toBe(200);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/client-errors`, report))).status).toBe(401);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/client-errors`, report, { cookie: alice.cookie }))).status).toBe(403);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/client-errors`, report, { ...alice, origin: "https://evil.example" }))).status).toBe(403);
    expect((await rows()).length).toBe(1);
  });

  it("伏せていない ID や問い合わせの文字列・決まった形でない値は断る", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const bad = [
      { ...report, path: `/api/polls/${s.pollId}/slots` },
      { ...report, path: "/api/polls/:id/member-search?q=alice" },
      { ...report, path: "https://example.com/x" },
      { ...report, ray: "<script>" },
      { ...report, status: 1000 },
      { ...report, method: "HEAD" },
      { ...report, extra: "x" },
    ];
    for (const b of bad) expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/client-errors`, b, org))).status).toBe(400);
    expect((await rows()).length).toBe(0);
  });

  it("1 人あたり 1 時間に 10 件までしか残さない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    for (let i = 0; i < 12; i++) expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/client-errors`, report, org))).status).toBe(200);
    expect((await rows()).length).toBe(10);
  });
});
