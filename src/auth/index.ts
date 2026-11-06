// 入力リンク（ワンタイムトークン）とセッション（docs/security-design.md §4.3）
import type { Purpose, Role } from "../shared/model";
import { nowSec, randomToken, sha256Hex } from "../lib";
import type { LinkTokenRow, SessionRow } from "../db";

export const LINK_TTL = 10 * 60; // 10 分
export const SESSION_TTL = 12 * 60 * 60; // 12 時間（延長なし）

export function sessionCookieName(pollId: string): string {
  // 1 つの調整に 1 つのセッション。調整ごとに Cookie を分け、複数の調整を同時に開けるようにする
  return `__Host-s_${pollId}`;
}

/** 入力リンクのトークンを発行し、リンクの URL を返す（トークンは URL フラグメントに置く） */
export async function issueLink(
  db: D1Database,
  origin: string,
  pollId: string,
  userId: string,
  role: Role,
  purpose: Purpose,
): Promise<string> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  await db
    .prepare("INSERT INTO link_tokens (token_hash, poll_id, user_id, role, purpose, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(hash, pollId, userId, role, purpose, nowSec() + LINK_TTL)
    .run();
  return `${origin}/l#t=${token}`;
}

/** トークンを 1 回だけ使えるように消費する。競合しても二重には使えない */
export async function consumeLink(db: D1Database, token: string): Promise<LinkTokenRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const now = nowSec();
  const r = await db
    .prepare("UPDATE link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, hash, now)
    .run();
  if (r.meta.changes !== 1) return null;
  return db.prepare("SELECT * FROM link_tokens WHERE token_hash = ?").bind(hash).first<LinkTokenRow>();
}

export async function createSession(
  db: D1Database,
  pollId: string,
  userId: string,
  role: Role,
): Promise<{ sid: string; csrf: string }> {
  const sid = randomToken(32);
  const csrf = randomToken(32);
  const now = nowSec();
  await db
    .prepare("INSERT INTO sessions (sid_hash, poll_id, user_id, role, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(sid), pollId, userId, role, csrf, now + SESSION_TTL, now)
    .run();
  return { sid, csrf };
}

export async function getSession(db: D1Database, pollId: string, sid: string): Promise<SessionRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
  return db
    .prepare("SELECT * FROM sessions WHERE sid_hash = ? AND poll_id = ? AND expires_at > ?")
    .bind(await sha256Hex(sid), pollId, nowSec())
    .first<SessionRow>();
}

export function sessionCookie(pollId: string, sid: string): string {
  return `${sessionCookieName(pollId)}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(pollId: string): string {
  return `${sessionCookieName(pollId)}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
