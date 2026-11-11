// Cron（1 日 2 回: UTC 4 時・16 時 = 日本時間 13 時・1 時。docs/design.md §3.2, §5.5, §7.4）
// UTC 1:00〜1:04・8:00〜8:04（日本時間 10:00〜10:04・17:00〜17:04）の回は、予定のリマインド（§5.7）だけを行う
import type { Env } from "../core/env";
import { deletePolls } from "../db";
import { syncCommands } from "../discord/commands";
import { discord } from "../discord/rest";
import { nowSec } from "../core/lib";
import { RETENTION } from "../polls/create";
import { syncNow } from "../polls/sync";
import { runDayReminder } from "./day-reminder";

/**
 * D1 は無料プランだと、1 回の実行（invocation）で問い合わせられる回数が 50 回まで。
 * batch の中の文も 1 文ずつ数えられる前提で、Cron 1 回で使う文の数をこの範囲に収める。
 * - 募集メッセージの更新 1 件: 3 文（最終更新時刻の読み込み・更新権利の取得・調整と関連データの読み込み）、失敗時 +2
 * - 共通: 締切の処理 1、更新対象の検索 1、コマンドの確認 1〜2
 * - 削除（日本時間 1 時の回だけ）: 期限切れのトークンなど 3、期限切れの調整 7、
 *   サーバー数の通知の確認 1〜2、外されたサーバーの検索 1、外されたサーバーの削除 8（サーバーの数によらず）
 * 13 時の回: 2 + 8 × 5（失敗しても）+ 2 = 44 文まで。1 時の回: 2 + 4 × 5 + 21 + 2 = 45 文まで。
 * 残った分は、次の Cron・回答の保存・主催者の［今すぐ更新］で反映される。
 */
const MAX_SYNC_PER_RUN = 8;
/** 削除の回で更新する募集メッセージの上限（削除に回数を残す） */
const MAX_SYNC_ON_CLEANUP_RUN = 4;
/** Bot が入っているサーバーの一覧を読むページ数の上限（200 件 × 10 = 2000 サーバー） */
const MAX_GUILD_PAGES = 10;
/** Bot が入っているサーバーの数がこれを超えたら、運営者に通知する（§14） */
export const GUILD_ALERT_THRESHOLD = 75;

export async function runCron(env: Env, scheduledTime: number): Promise<void> {
  const hourUtc = new Date(scheduledTime).getUTCHours();
  // 日本時間 10 時台・17 時台の回は、予定のリマインドだけ（送る数に 1 回あたりの上限を使うため、ほかの処理はしない）
  if (hourUtc === 1 || hourUtc === 8) return runDayReminder(env, scheduledTime);
  const now = nowSec();
  const isCleanupRun = hourUtc === 16; // 日本時間 1 時
  const maxSync = isCleanupRun ? MAX_SYNC_ON_CLEANUP_RUN : MAX_SYNC_PER_RUN;

  // 締切を過ぎた調整を closed にする（このとき募集メッセージも「締切を過ぎました」に更新する）
  const closed = await env.DB.prepare(
    "UPDATE polls SET status = 'closed' WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ? RETURNING id, message_id",
  )
    .bind(now)
    .all<{ id: string; message_id: string | null }>();
  const toSync: string[] = closed.results.filter((p) => p.message_id).map((p) => p.id).slice(0, maxSync);

  // 未反映の回答の変更がある募集メッセージ
  if (toSync.length < maxSync) {
    const targets = await env.DB.prepare(
      "SELECT id FROM polls p WHERE message_id IS NOT NULL AND status IN ('open','closed','fixed') " +
        "AND EXISTS (SELECT 1 FROM answers a WHERE a.poll_id = p.id AND a.updated_at > COALESCE(p.last_synced_at, 0)) " +
        "ORDER BY last_synced_at LIMIT ?",
    )
      .bind(maxSync)
      .all<{ id: string }>();
    for (const t of targets.results) {
      if (toSync.length >= maxSync) break;
      if (!toSync.includes(t.id)) toSync.push(t.id);
    }
  }
  for (const id of toSync) await syncNow(env, id);

  if (isCleanupRun) await cleanup(env, now);

  await syncCommands(env, { force: true }).catch((e) => console.error(JSON.stringify({ event: "commands_sync_failed", error: String(e) })));
}

/**
 * サーバーの数が GUILD_ALERT_THRESHOLD を超えたら、ALERT_WEBHOOK_URL に 1 回だけ通知する。
 * 通知したことは meta に残し、数が目安以下に戻ったら消す（また超えたら、もう一度通知する）
 */
async function alertGuildCount(env: Env, count: number): Promise<void> {
  // 通知の失敗（D1・Discord のエラー）で、外されたサーバーのデータの削除が止まらないよう、ここで受け止める
  try {
    const db = env.DB;
    const KEY = "guild_alert_sent";
    if (count <= GUILD_ALERT_THRESHOLD) {
      await db.prepare("DELETE FROM meta WHERE key = ?").bind(KEY).run();
      return;
    }
    const sent = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(KEY).first<{ value: string }>();
    if (sent) return;
    const hook = parseWebhookUrl(env.ALERT_WEBHOOK_URL);
    if (!hook) {
      console.error(JSON.stringify({ event: "guild_alert_skipped", reason: env.ALERT_WEBHOOK_URL ? "bad_webhook_url" : "no_webhook_url", count }));
      return;
    }
    await discord(env, "POST", `/webhooks/${hook.id}/${hook.token}`, {
      content: `DIscheduler の Bot が入っているサーバーが ${count} になりました（通知の目安: ${GUILD_ALERT_THRESHOLD}）。`,
      allowed_mentions: { parse: [] },
    }, { auth: "none" });
    await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(KEY, String(count)).run();
  } catch (e) {
    console.error(JSON.stringify({ event: "guild_alert_failed", error: e instanceof Error ? e.message : "unknown" }));
  }
}

/**
 * Discord の Webhook の URL から ID とトークンを取り出す。discord.com・discordapp.com と、
 * PTB・Canary の版のアドレス、API の版（/api/v10/…）、末尾の「/」やクエリ（?wait=true など）を受け付ける
 */
export function parseWebhookUrl(raw: string | undefined): { id: string; token: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const hosts = ["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com", "ptb.discordapp.com", "canary.discordapp.com"];
  if (u.protocol !== "https:" || !hosts.includes(u.hostname)) return null;
  const m = /^\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{20,100})\/?$/.exec(u.pathname);
  return m ? { id: m[1]!, token: m[2]! } : null;
}

async function cleanup(env: Env, now: number): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM link_tokens WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now),
    // 主催者の調整一覧（§6.11）のリンクとセッションも、期限が切れたら消す
    db.prepare("DELETE FROM list_tokens WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM list_sessions WHERE expires_at <= ?").bind(now),
    // 最近使った時間帯は、最後に使ってから保持期間（6 ヶ月）を過ぎたら消す
    db.prepare("DELETE FROM guild_recent_times WHERE updated_at <= ?").bind(now - RETENTION),
  ]);
  // 保持期間を過ぎた調整を、件数によらず 1 回の batch で削除する
  await deletePolls(db, { sql: "purge_after <= ?", value: now });

  // Bot が外されたサーバーのデータを削除する
  try {
    const guilds = new Set<string>();
    let after = "0";
    let complete = false;
    for (let page = 0; page < MAX_GUILD_PAGES; page++) {
      const batch = await discord<{ id: string }[]>(env, "GET", `/users/@me/guilds?limit=200&after=${after}`);
      for (const g of batch) guilds.add(g.id);
      if (batch.length < 200) {
        complete = true;
        break;
      }
      after = batch[batch.length - 1]!.id;
    }
    // サーバーの数を毎日ログに残し、上限の目安を超えたら運営者に通知する（一覧を読み切れなくても、数は少なくともこれだけある）
    console.log(JSON.stringify({ event: "guild_count", count: guilds.size, complete }));
    await alertGuildCount(env, guilds.size);
    // 一覧を最後まで読めなかったときは、まだ使っているサーバーのデータを消さないよう削除しない
    if (!complete) {
      console.error(JSON.stringify({ event: "guild_check_skipped", reason: "guild_list_incomplete", read: guilds.size }));
      return;
    }
    const stored = await db.prepare("SELECT guild_id FROM polls UNION SELECT guild_id FROM guild_settings UNION SELECT guild_id FROM guild_recent_times").all<{ guild_id: string }>();
    const removed = stored.results.map((g) => g.guild_id).filter((id) => !guilds.has(id));
    if (removed.length) {
      // 外されたサーバーの既定値・最近使った時間帯と調整を、サーバーの数によらず 1 回の batch で削除する
      const ids = JSON.stringify(removed);
      await deletePolls(db, { sql: "guild_id IN (SELECT value FROM json_each(?))", value: ids }, [
        db.prepare("DELETE FROM guild_settings WHERE guild_id IN (SELECT value FROM json_each(?))").bind(ids),
        db.prepare("DELETE FROM guild_recent_times WHERE guild_id IN (SELECT value FROM json_each(?))").bind(ids),
        db.prepare("DELETE FROM list_tokens WHERE guild_id IN (SELECT value FROM json_each(?))").bind(ids),
        db.prepare("DELETE FROM list_sessions WHERE guild_id IN (SELECT value FROM json_each(?))").bind(ids),
      ]);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "guild_check_failed", error: e instanceof Error ? e.message : "unknown" }));
  }
  console.log(JSON.stringify({ event: "cleanup_done" }));
}
