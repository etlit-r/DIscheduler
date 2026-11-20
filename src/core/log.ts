// エラーの記録（docs/design.md §12）。
// Cloudflare Pages（本体）はログを残さないので、予期しないエラーの要約を D1 の error_logs にも残す（7 日で Cron が消す）。
// 個人の情報（回答・表示名・ユーザー ID・トークン・IP アドレス）は入れない。エラーが続いても D1 の書き込みが増えすぎないよう、
// 1 時間に ERROR_LOG_HOURLY_MAX 件までにする。記録に失敗しても、元の処理は止めない
import type { Env } from "./env";
import { nowSec } from "./lib";

export const ERROR_LOG_HOURLY_MAX = 200;
export const ERROR_LOG_RETENTION = 7 * 86400;

export interface ErrorLogFields {
  /** 利用者の画面に出した参照番号 */
  ref?: string;
  pollId?: string;
}

/** エラーの文を、記録してよい形にする（制御文字を除き、300 文字までにする） */
export function errorSummary(e: unknown): string {
  const s = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : typeof e === "string" ? e : "unknown";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
}

/** console にエラーを出し、D1 にも要約を残す。呼び出し側は await するか waitUntil に渡す */
export async function logError(env: Pick<Env, "DB">, event: string, e: unknown, fields: ErrorLogFields = {}): Promise<void> {
  const message = errorSummary(e);
  console.error(JSON.stringify({ event, ...fields, error: message }));
  const now = nowSec();
  try {
    await env.DB.prepare(
      "INSERT INTO error_logs (at, event, ref, poll_id, message) SELECT ?1, ?2, ?3, ?4, ?5 " +
        "WHERE (SELECT COUNT(*) FROM error_logs WHERE at > ?1 - 3600) < ?6",
    )
      .bind(now, event.slice(0, 64), fields.ref ?? null, fields.pollId ?? null, message, ERROR_LOG_HOURLY_MAX)
      .run();
  } catch (err) {
    console.error(JSON.stringify({ event: "error_log_failed", error: errorSummary(err) }));
  }
}
