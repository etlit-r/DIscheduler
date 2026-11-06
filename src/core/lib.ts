// 共通の小さな道具（乱数・ハッシュ・時刻・エラー）

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** CSPRNG によるランダム文字列（base64url） */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

/** 調整・候補・選択肢の ID（128bit） */
export function randomId(): string {
  return randomToken(16);
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定数時間比較 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 利用者に見せてよいエラー（メッセージは日本語の説明） */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** D1 の無料枠（1 日の読み書きの上限）を超えたときのエラーかどうか */
export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return /exceeded|quota|limit.*(reached|exceeded)|too many requests/i.test(msg) && /D1|database|storage|rows/i.test(msg);
}

export const QUOTA_MESSAGE =
  "本日分の無料枠（データベースの読み書きの上限）を超えたため、DIscheduler は日本時間 午前 9 時まで使えません。" +
  "DIscheduler は Cloudflare の無料枠だけで運営しているため、利用が多い日はこの上限に達することがあります。入力済みの回答は消えていません。";

export const DAY = 86400;
