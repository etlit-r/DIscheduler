import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index";
import { issueLink } from "../src/auth";
import { CHOICE_TEMPLATES } from "../src/shared/model";
import { nowSec, randomId } from "../src/core/lib";
import type { Env } from "../src/core/env";

export const ORIGIN = "https://discheduler.example.workers.dev";
export const GUILD = "200000000000000001";
export const CHANNEL = "300000000000000001";
export const ORGANIZER = "400000000000000001";
export const ALICE = "400000000000000002";
export const BOB = "400000000000000003";
export const OUTSIDER = "400000000000000099";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

export async function call(req: Request, e: Env = testEnv()): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export interface Seeded {
  pollId: string;
  slotIds: string[];
  choiceIds: string[];
}

export async function seedPoll(opts: { status?: string; participants?: string[]; deadlineAt?: number | null; messageId?: string | null; joinPolicy?: string } = {}): Promise<Seeded> {
  const db = (env as unknown as Env).DB;
  const now = nowSec();
  const pollId = randomId();
  const status = opts.status ?? "open";
  await db
    .prepare(
      "INSERT INTO polls (id, guild_id, channel_id, message_id, organizer_id, title, target_type, status, deadline_at, join_policy, created_at, updated_at, purge_after) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'channel', ?, ?, ?, ?, ?, ?)",
    )
    .bind(pollId, GUILD, CHANNEL, opts.messageId === undefined ? "500000000000000001" : opts.messageId, ORGANIZER, "定例会", status, opts.deadlineAt === undefined ? now + 7 * 86400 : opts.deadlineAt, opts.joinPolicy ?? "closed", now, now, now + 180 * 86400)
    .run();
  const slotIds = [randomId(), randomId(), randomId()];
  const base = now + 3 * 86400;
  for (const [i, id] of slotIds.entries()) {
    await db.prepare("INSERT INTO slots (id, poll_id, start_at, end_at, all_day, position) VALUES (?, ?, ?, ?, 0, ?)").bind(id, pollId, base + i * 86400, base + i * 86400 + 7200, i).run();
  }
  const choiceIds: string[] = [];
  for (const [i, c] of CHOICE_TEMPLATES[0]!.choices.entries()) {
    const id = randomId();
    choiceIds.push(id);
    await db.prepare("INSERT INTO choices (id, poll_id, symbol, label, kind, score, color, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, pollId, c.symbol, c.label, c.kind, c.score, c.color, i).run();
  }
  for (const u of opts.participants ?? [ORGANIZER, ALICE, BOB]) {
    await db.prepare("INSERT INTO participants (poll_id, user_id, display_name) VALUES (?, ?, ?)").bind(pollId, u, `user-${u.slice(-2)}`).run();
  }
  return { pollId, slotIds, choiceIds };
}

export function tokenFromUrl(url: string): string {
  return url.split("#t=")[1]!;
}

/** 入力リンクを発行してセッションに交換し、Cookie と CSRF トークンを返す */
export async function login(pollId: string, userId: string, role: "organizer" | "participant", purpose: "edit" | "answer" | "view" = "answer") {
  const url = await issueLink((env as unknown as Env).DB, ORIGIN, pollId, userId, role, purpose);
  const res = await call(jsonReq("POST", "/api/session", { token: tokenFromUrl(url) }));
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("Set-Cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const data = (await (await call(new Request(`${ORIGIN}/api/polls/${pollId}`, { headers: { Cookie: cookie } }))).json()) as { csrfToken: string };
  return { cookie, csrf: data.csrfToken };
}

export function jsonReq(method: string, path: string, body?: unknown, opts: { cookie?: string; csrf?: string; origin?: string | null; contentType?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  headers["Content-Type"] = opts.contentType ?? "application/json";
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.csrf) headers["X-CSRF-Token"] = opts.csrf;
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function getReq(path: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

export interface DiscordCall {
  method: string;
  path: string;
  body: unknown;
}

/** Discord API への通信を差し替える */
export function mockDiscord(handler: (c: DiscordCall) => unknown = () => ({})): DiscordCall[] {
  const calls: DiscordCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace("https://discord.test/api/v10", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const c = { method: init?.method ?? "GET", path, body };
    calls.push(c);
    const out = handler(c);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

/** API のエラー応答の本文 */
export async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

/** 調整の行をそのまま読む */
export function pollRow(id: string) {
  return (env as unknown as Env).DB.prepare("SELECT * FROM polls WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

/**
 * 時計を、いまの 1 時間の 25 分（10 分・1 時間の区切りのどちらからも離れた時刻）に止める。
 * 回数制限の区切りをテストの途中でまたぐと、数え直しになってテストが失敗するため
 */
export function freezeMidWindow(): void {
  const t = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 25 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(t);
}
