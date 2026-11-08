// Cron（1 日 2 回: UTC 4 時・16 時 = 日本時間 13 時・1 時。docs/design.md §3.2, §5.5, §7.4）
import type { Env } from "../core/env";
import { deletePollData } from "../db";
import { syncCommands } from "../discord/commands";
import { discord } from "../discord/rest";
import { nowSec } from "../core/lib";
import { syncNow } from "../polls/sync";

/** 1 回の実行で更新する募集メッセージの上限（Workers 無料プランのサブリクエスト上限 50 に収める） */
const MAX_SYNC_PER_RUN = 35;
/** Bot が入っているサーバーの一覧を読むページ数の上限（200 件 × 10 = 2000 サーバー） */
const MAX_GUILD_PAGES = 10;

export async function runCron(env: Env, scheduledTime: number): Promise<void> {
  const now = nowSec();
  const hourUtc = new Date(scheduledTime).getUTCHours();

  // 締切を過ぎた調整を closed にし、その募集メッセージも「締切を過ぎました」に更新する
  const closed = await env.DB.prepare(
    "UPDATE polls SET status = 'closed' WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ? RETURNING id, message_id",
  )
    .bind(now)
    .all<{ id: string; message_id: string | null }>();
  const synced = new Set<string>();
  for (const p of closed.results) {
    if (!p.message_id || synced.size >= MAX_SYNC_PER_RUN) continue;
    await syncNow(env, p.id);
    synced.add(p.id);
  }

  // 未反映の回答の変更がある募集メッセージを更新する
  const targets = await env.DB.prepare(
    "SELECT id FROM polls p WHERE message_id IS NOT NULL AND status IN ('open','closed','fixed') " +
      "AND EXISTS (SELECT 1 FROM answers a WHERE a.poll_id = p.id AND a.updated_at > COALESCE(p.last_synced_at, 0)) " +
      "ORDER BY last_synced_at LIMIT ?",
  )
    .bind(MAX_SYNC_PER_RUN)
    .all<{ id: string }>();
  for (const t of targets.results) {
    if (synced.has(t.id) || synced.size >= MAX_SYNC_PER_RUN) continue;
    await syncNow(env, t.id);
    synced.add(t.id);
  }

  // 日本時間 1 時（UTC 16 時）の回だけ、期限切れデータを削除する
  if (hourUtc === 16) await cleanup(env, now);

  await syncCommands(env, { force: true }).catch((e) => console.error(JSON.stringify({ event: "commands_sync_failed", error: String(e) })));
}

async function cleanup(env: Env, now: number): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM link_tokens WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now),
  ]);
  const expired = await db.prepare("SELECT id FROM polls WHERE purge_after <= ? LIMIT 200").bind(now).all<{ id: string }>();
  for (const p of expired.results) await deletePollData(db, p.id);

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
    // 一覧を最後まで読めなかったときは、まだ使っているサーバーのデータを消さないよう削除しない
    if (!complete) {
      console.error(JSON.stringify({ event: "guild_check_skipped", reason: "guild_list_incomplete", read: guilds.size }));
      return;
    }
    const stored = await db.prepare("SELECT guild_id FROM polls UNION SELECT guild_id FROM guild_settings").all<{ guild_id: string }>();
    for (const g of stored.results) {
      if (guilds.has(g.guild_id)) continue;
      await db.prepare("DELETE FROM guild_settings WHERE guild_id = ?").bind(g.guild_id).run();
      const polls = await db.prepare("SELECT id FROM polls WHERE guild_id = ?").bind(g.guild_id).all<{ id: string }>();
      for (const p of polls.results) await deletePollData(db, p.id);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "guild_check_failed", error: e instanceof Error ? e.message : "unknown" }));
  }
  console.log(JSON.stringify({ event: "cleanup_done", purged: expired.results.length }));
}
