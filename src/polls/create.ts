// 調整の作成・参加者の設定など、Discord と Web の両方から使う処理
import type { Env } from "../core/env";
import { defaultChoiceStatements, hitRateLimit, rateLimitResetIn, type PollRow } from "../db";
import { extractParticipants, fetchMember, type Candidate } from "../discord/members";
import { getGuildSettings } from "../guilds/settings";
import { DAY, nowSec, randomId } from "../core/lib";

export const DRAFT_TTL = 3 * DAY;
export const RETENTION = 180 * DAY;
export const DEFAULT_DEADLINE_DAYS = 7;

export interface CreateOptions {
  guildId: string;
  channelId: string;
  organizerId: string;
  title: string | null;
  members: "auto" | "manual" | null;
  roleId: string | null;
  deadlineDays: number | null;
}

export type CreateResult =
  | { ok: true; pollId: string; reused: boolean; notice: string | null }
  | { ok: false; message: string };

/** 未入力（タイトルも候補もない）の下書き。あれば使い回す（§4.4） */
async function findEmptyDraft(db: D1Database, organizerId: string, channelId: string): Promise<PollRow | null> {
  return db
    .prepare(
      "SELECT * FROM polls WHERE organizer_id = ? AND channel_id = ? AND status = 'draft' AND title IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM slots WHERE slots.poll_id = polls.id) ORDER BY created_at DESC LIMIT 1",
    )
    .bind(organizerId, channelId)
    .first<PollRow>();
}

export async function createOrReuseDraft(env: Env, opts: CreateOptions): Promise<CreateResult> {
  let o = opts;
  const db = env.DB;
  const now = nowSec();
  const hasOptions = o.title !== null || o.members !== null || o.roleId !== null || o.deadlineDays !== null;

  const existing = await findEmptyDraft(db, o.organizerId, o.channelId);
  if (existing && !hasOptions) {
    return { ok: true, pollId: existing.id, reused: true, notice: null };
  }

  // 作成数の上限（§5.4.2）
  if (!(await hitRateLimit(db, `create:user:${o.organizerId}`, 10, 3600, now))) {
    const min = Math.ceil(rateLimitResetIn(3600, now) / 60);
    return { ok: false, message: `作成数の上限（1 時間に 10 件）に達しました。${min} 分後に再度お試しください。` };
  }
  if (!(await hitRateLimit(db, `create:guild:${o.guildId}`, 100, DAY, now))) {
    return { ok: false, message: "このサーバー全体の作成数の上限（1 日 100 件）に達しました。明日もう一度お試しください。" };
  }
  const active = await db
    .prepare("SELECT COUNT(*) AS n FROM polls WHERE channel_id = ? AND status IN ('draft','open')")
    .bind(o.channelId)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= 20 && !existing) {
    return { ok: false, message: "このチャンネルの進行中の調整が多すぎます（20 件まで）。不要な調整を削除してください。" };
  }

  // コマンドで指定がなければ、サーバーの既定値を使う（§5.3.1）
  let usedDefaultRole = false;
  if (o.members === null && o.roleId === null) {
    const def = await getGuildSettings(db, o.guildId);
    if (def.mode === "manual") o = { ...o, members: "manual" };
    else if (def.mode === "role" && def.roleId) {
      o = { ...o, roleId: def.roleId };
      usedDefaultRole = true;
    }
  }
  const targetType = o.members === "manual" ? "manual" : o.roleId ? "role" : "channel";
  let notice: string | null = null;
  let participants: Candidate[] = [];
  let finalTarget: "channel" | "role" | "manual" = targetType;
  if (targetType !== "manual") {
    let r = await extractParticipants(env, o.guildId, o.channelId, o.roleId);
    if (r.ok && r.members.length === 0 && usedDefaultRole) {
      // 既定のロールが削除された・誰も持っていない場合は、チャンネルのメンバーにする
      r = await extractParticipants(env, o.guildId, o.channelId, null);
      finalTarget = "channel";
      o = { ...o, roleId: null };
      notice = "サーバーの既定のロールを持つメンバーがいないため、このチャンネルのメンバーを参加者にしました。";
    }
    if (r.ok) {
      participants = r.members;
    } else {
      finalTarget = "manual";
      notice = r.message;
    }
  }
  if (finalTarget === "manual") {
    // 手動のときは主催者だけを最初の参加者にする
    const me = await fetchMember(env, o.guildId, o.organizerId).catch(() => null);
    if (me) participants = [me];
  }

  const deadlineAt = o.deadlineDays ? now + o.deadlineDays * DAY : null;
  const pollId = existing?.id ?? randomId();
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    stmts.push(db.prepare("DELETE FROM participants WHERE poll_id = ?").bind(pollId));
    stmts.push(
      db
        .prepare("UPDATE polls SET title = ?, target_type = ?, target_id = ?, deadline_at = ?, updated_at = ?, purge_after = ? WHERE id = ?")
        .bind(o.title, finalTarget, finalTarget === "role" ? o.roleId : null, deadlineAt, now, now + DRAFT_TTL, pollId),
    );
  } else {
    stmts.push(
      db
        .prepare(
          "INSERT INTO polls (id, guild_id, channel_id, organizer_id, title, target_type, target_id, deadline_at, created_at, updated_at, purge_after) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(pollId, o.guildId, o.channelId, o.organizerId, o.title, finalTarget, finalTarget === "role" ? o.roleId : null, deadlineAt, now, now, now + DRAFT_TTL),
    );
    stmts.push(...defaultChoiceStatements(db, pollId));
  }
  for (const p of participants) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO participants (poll_id, user_id, display_name) VALUES (?, ?, ?)").bind(pollId, p.userId, p.displayName));
  }
  await db.batch(stmts);
  return { ok: true, pollId, reused: !!existing, notice };
}

/** 参加者の決め方を変えたときに、参加者を設定し直す（下書きのときだけ） */
export async function resetParticipants(
  env: Env,
  poll: PollRow,
  members: "auto" | "manual",
  roleId: string | null,
): Promise<{ notice: string | null; targetType: "channel" | "role" | "manual" }> {
  let participants: Candidate[] = [];
  let targetType: "channel" | "role" | "manual" = members === "manual" ? "manual" : roleId ? "role" : "channel";
  let notice: string | null = null;
  if (targetType !== "manual") {
    const r = await extractParticipants(env, poll.guild_id, poll.channel_id, roleId);
    if (r.ok) participants = r.members;
    else {
      targetType = "manual";
      notice = r.message;
    }
  }
  if (targetType === "manual") {
    const me = await fetchMember(env, poll.guild_id, poll.organizer_id).catch(() => null);
    if (me) participants = [me];
  }
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM answers WHERE poll_id = ?").bind(poll.id),
    db.prepare("DELETE FROM participants WHERE poll_id = ?").bind(poll.id),
    db.prepare("UPDATE polls SET target_type = ?, target_id = ?, updated_at = ? WHERE id = ?").bind(targetType, targetType === "role" ? roleId : null, nowSec(), poll.id),
    ...participants.map((p) =>
      db.prepare("INSERT OR IGNORE INTO participants (poll_id, user_id, display_name) VALUES (?, ?, ?)").bind(poll.id, p.userId, p.displayName),
    ),
  ]);
  return { notice, targetType };
}
