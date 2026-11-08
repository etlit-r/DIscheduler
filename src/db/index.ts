// D1 へのアクセス。SQL はすべてプリペアドステートメントで組み立てる（security-design T-1）
import type { ChoiceColor, ChoiceInput, ChoiceKind, PollStatus, Purpose, Role } from "../shared/model";
import { CHOICE_TEMPLATES } from "../shared/model";
import { randomId } from "../core/lib";

export interface PollRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  organizer_id: string;
  title: string | null;
  description: string | null;
  timezone: string;
  timezone_set: number;
  target_type: "channel" | "role" | "manual";
  target_id: string | null;
  join_policy: "closed" | "open";
  status: PollStatus;
  deadline_at: number | null;
  fixed_slot_id: string | null;
  fixed_at: number | null;
  discord_event_id: string | null;
  choices_version: number;
  last_synced_at: number | null;
  last_reminded_at: number | null;
  publishing_at: number | null;
  choices_changed_at: number | null;
  created_at: number;
  updated_at: number;
  purge_after: number;
}

export interface SlotRow {
  id: string;
  poll_id: string;
  start_at: number;
  end_at: number | null;
  all_day: number;
  position: number;
}

export interface ChoiceRow {
  id: string;
  poll_id: string;
  symbol: string;
  label: string;
  kind: ChoiceKind;
  score: number;
  color: ChoiceColor;
  position: number;
}

export interface ParticipantRow {
  poll_id: string;
  user_id: string;
  display_name: string;
  comment: string | null;
  answered_at: number | null;
}

export interface AnswerRow {
  poll_id: string;
  slot_id: string;
  user_id: string;
  choice_id: string;
  prev_choice_id: string | null;
  updated_at: number;
}

export interface SessionRow {
  sid_hash: string;
  poll_id: string;
  user_id: string;
  role: Role;
  csrf_token: string;
  expires_at: number;
  created_at: number;
}

export interface LinkTokenRow {
  token_hash: string;
  poll_id: string;
  user_id: string;
  role: Role;
  purpose: Purpose;
  expires_at: number;
  used_at: number | null;
}

export function getPoll(db: D1Database, id: string): Promise<PollRow | null> {
  return db.prepare("SELECT * FROM polls WHERE id = ?").bind(id).first<PollRow>();
}

export async function getSlots(db: D1Database, pollId: string): Promise<SlotRow[]> {
  const r = await db.prepare("SELECT * FROM slots WHERE poll_id = ? ORDER BY start_at, position").bind(pollId).all<SlotRow>();
  return r.results;
}

export async function getChoices(db: D1Database, pollId: string): Promise<ChoiceRow[]> {
  const r = await db.prepare("SELECT * FROM choices WHERE poll_id = ? ORDER BY position").bind(pollId).all<ChoiceRow>();
  return r.results;
}

export async function getParticipants(db: D1Database, pollId: string): Promise<ParticipantRow[]> {
  const r = await db
    .prepare("SELECT * FROM participants WHERE poll_id = ? ORDER BY display_name COLLATE NOCASE")
    .bind(pollId)
    .all<ParticipantRow>();
  return r.results;
}

export function getParticipant(db: D1Database, pollId: string, userId: string): Promise<ParticipantRow | null> {
  return db.prepare("SELECT * FROM participants WHERE poll_id = ? AND user_id = ?").bind(pollId, userId).first<ParticipantRow>();
}

export async function getAnswers(db: D1Database, pollId: string): Promise<AnswerRow[]> {
  const r = await db.prepare("SELECT * FROM answers WHERE poll_id = ?").bind(pollId).all<AnswerRow>();
  return r.results;
}

/** 最終更新より後に保存・変更された回答の件数（§6.5） */
export async function countPendingAnswers(db: D1Database, poll: PollRow): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM answers WHERE poll_id = ? AND updated_at > ?")
    .bind(poll.id, poll.last_synced_at ?? 0)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export function defaultChoiceStatements(db: D1Database, pollId: string): D1PreparedStatement[] {
  return insertChoiceStatements(db, pollId, CHOICE_TEMPLATES[0]!.choices);
}

export function insertChoiceStatements(db: D1Database, pollId: string, choices: readonly ChoiceInput[]): D1PreparedStatement[] {
  return choices.map((c, i) =>
    db
      .prepare("INSERT INTO choices (id, poll_id, symbol, label, kind, score, color, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(randomId(), pollId, c.symbol, c.label, c.kind, c.score, c.color, i),
  );
}

export interface PollWithData {
  poll: PollRow;
  slots: SlotRow[];
  choices: ChoiceRow[];
  participants: ParticipantRow[];
  answers: AnswerRow[];
}

/**
 * 調整と、その候補・選択肢・参加者・回答を 1 つの SQL 文で読む（D1 の 1 回あたりの問い合わせ回数を節約するため）。
 * 関連データは JSON の配列として受け取り、並び順は読み込んだあとにそろえる
 */
export async function readPollWithData(db: D1Database, pollId: string): Promise<PollWithData | null> {
  const row = await db
    .prepare(
      `SELECT p.*,
        (SELECT json_group_array(json_object('id', id, 'poll_id', poll_id, 'start_at', start_at, 'end_at', end_at, 'all_day', all_day, 'position', position))
           FROM slots WHERE poll_id = p.id) AS j_slots,
        (SELECT json_group_array(json_object('id', id, 'poll_id', poll_id, 'symbol', symbol, 'label', label, 'kind', kind, 'score', score, 'color', color, 'position', position))
           FROM choices WHERE poll_id = p.id) AS j_choices,
        (SELECT json_group_array(json_object('poll_id', poll_id, 'user_id', user_id, 'display_name', display_name, 'comment', comment, 'answered_at', answered_at))
           FROM participants WHERE poll_id = p.id) AS j_participants,
        (SELECT json_group_array(json_object('poll_id', poll_id, 'slot_id', slot_id, 'user_id', user_id, 'choice_id', choice_id, 'prev_choice_id', prev_choice_id, 'updated_at', updated_at))
           FROM answers WHERE poll_id = p.id) AS j_answers
       FROM polls p WHERE p.id = ?`,
    )
    .bind(pollId)
    .first<PollRow & { j_slots: string; j_choices: string; j_participants: string; j_answers: string }>();
  if (!row) return null;
  const { j_slots, j_choices, j_participants, j_answers, ...poll } = row;
  const slots = (JSON.parse(j_slots) as SlotRow[]).sort((a, b) => a.start_at - b.start_at || a.position - b.position);
  const choices = (JSON.parse(j_choices) as ChoiceRow[]).sort((a, b) => a.position - b.position);
  const participants = (JSON.parse(j_participants) as ParticipantRow[]).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const answers = JSON.parse(j_answers) as AnswerRow[];
  return { poll: poll as PollRow, slots, choices, participants, answers };
}

/**
 * 参加者をまとめて追加する文（人数によらず 1 文。D1 の問い合わせ回数とバインド変数の上限 100 を避けるため、JSON で渡す）
 */
export function insertParticipantsStatement(db: D1Database, pollId: string, people: readonly { userId: string; displayName: string }[]): D1PreparedStatement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO participants (poll_id, user_id, display_name) " +
        "SELECT ?, json_extract(value, '$.u'), json_extract(value, '$.n') FROM json_each(?)",
    )
    .bind(pollId, JSON.stringify(people.map((p) => ({ u: p.userId, n: p.displayName }))));
}

/**
 * 条件に合う調整と関連データをまとめて削除する（外部キーの CASCADE に頼らず明示的に消す）。
 * 調整の数によらず、1 回の batch（7 文）で済む
 */
type PollFilter =
  | { sql: "id = ?" | "purge_after <= ?"; value: string | number }
  | { sql: "guild_id IN (SELECT value FROM json_each(?))"; value: string };

export async function deletePolls(db: D1Database, f: PollFilter, extra: D1PreparedStatement[] = []): Promise<void> {
  const sub = `SELECT id FROM polls WHERE ${f.sql}`;
  await db.batch([
    ...extra,
    db.prepare(`DELETE FROM answers WHERE poll_id IN (${sub})`).bind(f.value),
    db.prepare(`DELETE FROM participants WHERE poll_id IN (${sub})`).bind(f.value),
    db.prepare(`DELETE FROM slots WHERE poll_id IN (${sub})`).bind(f.value),
    db.prepare(`DELETE FROM choices WHERE poll_id IN (${sub})`).bind(f.value),
    db.prepare(`DELETE FROM link_tokens WHERE poll_id IN (${sub})`).bind(f.value),
    db.prepare(`DELETE FROM sessions WHERE poll_id IN (${sub})`).bind(f.value),
    db.prepare(`DELETE FROM polls WHERE ${f.sql}`).bind(f.value),
  ]);
}

/** 1 つの調整と関連データを削除する */
export function deletePollData(db: D1Database, pollId: string): Promise<void> {
  return deletePolls(db, { sql: "id = ?", value: pollId });
}

/** 固定ウィンドウのレート制限。上限を超えたら false（security-design D-2） */
export async function hitRateLimit(db: D1Database, key: string, limit: number, windowSec: number, now: number): Promise<boolean> {
  const windowStart = Math.floor(now / windowSec) * windowSec;
  const k = `${key}:${windowStart}`;
  const row = await db
    .prepare(
      "INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) " +
        "ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(k, windowStart + windowSec)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** 残り時間（秒）を知るために、レート制限のウィンドウの終わりを返す */
export function rateLimitResetIn(windowSec: number, now: number): number {
  return Math.floor(now / windowSec) * windowSec + windowSec - now;
}
