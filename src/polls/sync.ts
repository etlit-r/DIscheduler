// 募集メッセージの更新（docs/design.md §5.5）
import type { Env } from "../core/env";
import { getAnswers, getChoices, getParticipants, getPoll, getSlots } from "../db";
import { buildPollMessage } from "../discord/messages";
import { discord, DiscordError } from "../discord/rest";
import { nowSec, sleep } from "../core/lib";

export const SYNC_INTERVAL = 30;

/** last_synced_at を条件付きで書き換え、更新する権利を取る（同時に走っても 1 回だけ更新する） */
async function claim(db: D1Database, pollId: string, now: number, minInterval: number): Promise<{ prev: number | null } | null> {
  const row = await db.prepare("SELECT last_synced_at FROM polls WHERE id = ?").bind(pollId).first<{ last_synced_at: number | null }>();
  if (!row) return null;
  const prev = row.last_synced_at;
  const r = await db
    .prepare("UPDATE polls SET last_synced_at = ? WHERE id = ? AND last_synced_at IS ? AND (last_synced_at IS NULL OR last_synced_at <= ?)")
    .bind(now, pollId, prev, now - minInterval)
    .run();
  return r.meta.changes === 1 ? { prev } : null;
}

/** 募集メッセージを今の内容で更新する。更新できたら true */
export async function syncNow(env: Env, pollId: string, minInterval = 0): Promise<boolean> {
  const now = nowSec();
  const c = await claim(env.DB, pollId, now, minInterval);
  if (!c) return false;
  const poll = await getPoll(env.DB, pollId);
  if (!poll || !poll.message_id) return false;
  try {
    const [slots, choices, participants, answers] = await Promise.all([
      getSlots(env.DB, pollId),
      getChoices(env.DB, pollId),
      getParticipants(env.DB, pollId),
      getAnswers(env.DB, pollId),
    ]);
    const msg = buildPollMessage({ poll, slots, choices, participants, answers, now });
    await discord(env, "PATCH", `/channels/${poll.channel_id}/messages/${poll.message_id}`, msg);
    return true;
  } catch (e) {
    // 失敗したら最終更新時刻を戻し、次の機会（回答の保存・手動更新・Cron）に任せる
    await env.DB.prepare("UPDATE polls SET last_synced_at = ? WHERE id = ? AND last_synced_at = ?").bind(c.prev, pollId, now).run();
    if (e instanceof DiscordError && e.status === 404) {
      await env.DB.prepare("UPDATE polls SET message_id = NULL WHERE id = ?").bind(pollId).run();
    }
    console.error(JSON.stringify({ event: "sync_failed", pollId, error: e instanceof Error ? e.message : "unknown" }));
    return false;
  }
}

/**
 * 回答の保存のあとに呼ぶ。30 秒以内に更新済みなら、30 秒の区切りが過ぎたところで 1 回だけ後追いで更新する
 * （ctx.waitUntil の中で実行する）
 */
export async function syncAfterAnswer(env: Env, pollId: string): Promise<void> {
  if (await syncNow(env, pollId, SYNC_INTERVAL)) return;
  const row = await env.DB.prepare("SELECT last_synced_at, message_id FROM polls WHERE id = ?").bind(pollId).first<{ last_synced_at: number | null; message_id: string | null }>();
  if (!row?.message_id || row.last_synced_at === null) return;
  const waitSec = row.last_synced_at + SYNC_INTERVAL - nowSec() + 1;
  if (waitSec > 0 && waitSec <= SYNC_INTERVAL + 1) await sleep(waitSec * 1000);
  // ほかの保存の後追いが先に更新していれば、ここでは何もしない
  const after = await env.DB.prepare("SELECT last_synced_at FROM polls WHERE id = ?").bind(pollId).first<{ last_synced_at: number | null }>();
  if (after && after.last_synced_at !== row.last_synced_at) return;
  await syncNow(env, pollId, SYNC_INTERVAL);
}
