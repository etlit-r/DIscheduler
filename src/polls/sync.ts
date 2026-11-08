// 募集メッセージの更新（docs/design.md §5.5）
import type { Env } from "../core/env";
import { parsePollWithData, pollWithDataStatement, type PollWithDataRow } from "../db";
import { buildPollMessage } from "../discord/messages";
import { discord, DiscordError } from "../discord/rest";
import { nowSec, sleep } from "../core/lib";

/** 連続した保存をまとめる間隔。ctx.waitUntil の上限（応答後およそ 30 秒）に収まるよう 20 秒にする */
export const SYNC_INTERVAL = 20;

/** 募集メッセージを今の内容で更新する。更新できたら true
 *
 * D1 への問い合わせは 3 文: まず 1 回の batch で「直前の最終更新時刻の読み込み・更新権利の取得」を行い、
 * 権利を取れたときだけ「調整と関連データの読み込み」をする（取れなかったときに重い読み込みをしないため）。
 * データは権利を取った「あと」に読むので、そのあいだに保存された回答が「反映済み」扱いになることはない。
 * 失敗したときは +1〜2 文。
 */
export async function syncNow(env: Env, pollId: string, minInterval = 0): Promise<boolean> {
  const db = env.DB;
  const now = nowSec();
  const [prevRes, claimRes] = await db.batch([
    db.prepare("SELECT last_synced_at FROM polls WHERE id = ?").bind(pollId),
    // 募集メッセージがないときは書き換えない（未反映の件数が 0 に見えてしまうため）
    db
      .prepare(
        "UPDATE polls SET last_synced_at = ? WHERE id = ? AND message_id IS NOT NULL AND (last_synced_at IS NULL OR last_synced_at <= ?)",
      )
      .bind(now, pollId, now - minInterval),
  ]);
  if ((claimRes?.meta.changes ?? 0) !== 1) return false;
  const prev = (prevRes?.results[0] as { last_synced_at: number | null } | undefined)?.last_synced_at ?? null;
  const data = parsePollWithData(await pollWithDataStatement(db, pollId).first<PollWithDataRow>());
  const poll = data?.poll;
  if (!data || !poll?.message_id) {
    await db.prepare("UPDATE polls SET last_synced_at = ? WHERE id = ? AND last_synced_at = ?").bind(prev, pollId, now).run();
    return false;
  }
  const messageId = poll.message_id;
  try {
    const msg = buildPollMessage({ ...data, now });
    await discord(env, "PATCH", `/channels/${poll.channel_id}/messages/${messageId}`, msg);
    return true;
  } catch (e) {
    // 失敗したら最終更新時刻を戻し、次の機会（回答の保存・手動更新・Cron）に任せる
    await db.prepare("UPDATE polls SET last_synced_at = ? WHERE id = ? AND last_synced_at = ?").bind(prev, pollId, now).run();
    if (e instanceof DiscordError && e.status === 404) {
      // 更新しようとしたメッセージが、まだ記録されているメッセージのときだけ消す
      // （投稿し直しで新しいメッセージに変わっていたら、その ID は残す）
      await db.prepare("UPDATE polls SET message_id = NULL WHERE id = ? AND message_id = ?").bind(pollId, messageId).run();
    }
    console.error(JSON.stringify({ event: "sync_failed", pollId, error: e instanceof Error ? e.message : "unknown" }));
    return false;
  }
}

/**
 * 回答の保存のあとに呼ぶ。SYNC_INTERVAL（20 秒）以内に更新済みなら、その区切りが過ぎたところで 1 回だけ後追いで更新する
 * （ctx.waitUntil の中で実行する）
 */
export async function syncAfterAnswer(env: Env, pollId: string): Promise<void> {
  if (await syncNow(env, pollId, SYNC_INTERVAL)) return;
  const row = await env.DB.prepare("SELECT last_synced_at, message_id FROM polls WHERE id = ?").bind(pollId).first<{ last_synced_at: number | null; message_id: string | null }>();
  if (!row?.message_id || row.last_synced_at === null) return;
  const waitSec = row.last_synced_at + SYNC_INTERVAL - nowSec() + 1;
  if (waitSec > SYNC_INTERVAL + 1) return;
  if (waitSec > 0) await sleep(waitSec * 1000);
  // ほかの保存の後追いが先に更新していれば、ここでは何もしない
  const after = await env.DB.prepare("SELECT last_synced_at FROM polls WHERE id = ?").bind(pollId).first<{ last_synced_at: number | null }>();
  if (after && after.last_synced_at !== row.last_synced_at) return;
  await syncNow(env, pollId, SYNC_INTERVAL);
}
