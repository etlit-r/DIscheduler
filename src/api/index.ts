// Web API（docs/design.md §8）
import { Hono, type Context } from "hono";
import * as v from "valibot";
import type { Env } from "../env";
import {
  clearSessionCookie,
  consumeLink,
  createSession,
  getSession,
  readCookie,
  sessionCookie,
  sessionCookieName,
} from "../auth";
import {
  countPendingAnswers,
  deletePollData,
  getAnswers,
  getChoices,
  getParticipant,
  getParticipants,
  getPoll,
  getSlots,
  hitRateLimit,
  insertChoiceStatements,
  type PollRow,
  type SessionRow,
} from "../db";
import { fetchMember, searchMembers } from "../discord/members";
import { buildDeletedMessage, buildMentionMessage, buildPollMessage, escapeMarkdown, messageLink } from "../discord/messages";
import { discord, DiscordError, type DiscordChannel, type DiscordRole } from "../discord/rest";
import { AppError, DAY, nowSec, randomId, timingSafeEqual } from "../lib";
import { DEFAULT_DEADLINE_DAYS, resetParticipants, RETENTION } from "../polls";
import { canAnswer, effectiveStatus, LIMITS } from "../shared/model";
import { isValidTimeZone, nextCronAt } from "../shared/time";
import { syncAfterAnswer, syncNow } from "../sync";
import { AnswersBody, ChoicesBody, FixBody, ParticipantsBody, PatchPollBody, SessionBody, SlotsBody } from "./schemas";

type Vars = { session: SessionRow; poll: PollRow };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// --- 共通の前処理 ---

api.use("*", async (c, next) => {
  if (c.env.MAINTENANCE === "1") throw new AppError(503, "maintenance", "DIscheduler は現在メンテナンス中です。");
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    // CSRF 対策: Origin の完全一致と JSON の Content-Type を必須にする（security-design T-3）
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) throw new AppError(403, "bad_origin", "不正なリクエストです。");
    const ct = c.req.header("Content-Type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) throw new AppError(415, "bad_content_type", "不正なリクエストです。");
    const len = Number(c.req.header("Content-Length") ?? "0");
    if (len > LIMITS.bodyBytesMax) throw new AppError(413, "too_large", "送信する内容が大きすぎます。");
  }
  await next();
});

async function readJson<T extends v.GenericSchema>(c: C | Context<{ Bindings: Env }>, schema: T): Promise<v.InferOutput<T>> {
  const text = await c.req.text();
  if (text.length > LIMITS.bodyBytesMax) throw new AppError(413, "too_large", "送信する内容が大きすぎます。");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError(400, "bad_json", "不正なリクエストです。");
  }
  const r = v.safeParse(schema, data);
  if (!r.success) {
    const msg = r.issues.find((i) => !i.message.startsWith("Invalid"))?.message ?? "入力内容が正しくありません。";
    throw new AppError(400, "invalid", msg);
  }
  return r.output;
}

// --- セッション ---

api.post("/session", async (c) => {
  const body = await readJson(c, SessionBody);
  const link = await consumeLink(c.env.DB, body.token);
  if (!link) throw new AppError(401, "link_expired", "リンクの有効期限が切れているか、すでに使われています。Discord からもう一度リンクを開いてください。");
  const poll = await getPoll(c.env.DB, link.poll_id);
  if (!poll || poll.status === "cancelled") throw new AppError(404, "not_found", "この調整は削除されました。");
  if (link.role === "participant" && !(await getParticipant(c.env.DB, poll.id, link.user_id))) {
    throw new AppError(403, "not_participant", "この調整の参加者ではありません。");
  }
  const { sid } = await createSession(c.env.DB, poll.id, link.user_id, link.role);
  const path = link.purpose === "edit" ? `/p/${poll.id}/edit` : link.purpose === "answer" ? `/p/${poll.id}/answer` : `/p/${poll.id}`;
  c.header("Set-Cookie", sessionCookie(poll.id, sid));
  return c.json({ redirect: path });
});

// --- 調整ごとの API（セッション必須） ---

const polls = new Hono<{ Bindings: Env; Variables: Vars }>();

polls.use("/:id/*", loadSession);
polls.use("/:id", loadSession);

async function loadSession(c: C, next: () => Promise<void>) {
  const id = c.req.param("id") ?? "";
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new AppError(404, "not_found", "調整が見つかりません。");
  const sid = readCookie(c.req.header("Cookie") ?? null, sessionCookieName(id));
  const session = sid ? await getSession(c.env.DB, id, sid) : null;
  if (!session) throw new AppError(401, "no_session", "リンクの有効期限が切れています。Discord からもう一度リンクを開いてください。");
  const poll = await getPoll(c.env.DB, id);
  if (!poll || poll.status === "cancelled") throw new AppError(404, "not_found", "この調整は削除されました。");
  if (c.req.method !== "GET") {
    const token = c.req.header("X-CSRF-Token") ?? "";
    if (!timingSafeEqual(token, session.csrf_token)) throw new AppError(403, "bad_csrf", "不正なリクエストです。画面を再読み込みしてください。");
  }
  c.set("session", session);
  c.set("poll", poll);
  await next();
}

function requireOrganizer(c: C): void {
  if (c.var.session.role !== "organizer" || c.var.poll.organizer_id !== c.var.session.user_id) {
    throw new AppError(403, "forbidden", "この操作は主催者だけができます。");
  }
}

function donationUrl(env: Env): string | null {
  const u = env.DONATION_URL;
  return u && /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/.test(u) ? u : null;
}

polls.get("/:id", async (c) => {
  const { poll, session } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  const isOrganizer = session.role === "organizer";
  if (poll.status === "draft" && !isOrganizer) throw new AppError(404, "not_found", "この調整はまだ公開されていません。");
  const [slots, choices, participants, answers] = await Promise.all([
    getSlots(db, poll.id),
    getChoices(db, poll.id),
    getParticipants(db, poll.id),
    getAnswers(db, poll.id),
  ]);
  const me = participants.find((p) => p.user_id === session.user_id);
  if (!me && !isOrganizer) throw new AppError(403, "not_participant", "この調整の参加者ではありません。");
  const pending = isOrganizer ? await countPendingAnswers(db, poll) : null;
  return c.json({
    now,
    csrfToken: session.csrf_token,
    donationUrl: donationUrl(c.env),
    poll: {
      id: poll.id,
      title: poll.title,
      description: poll.description,
      status: effectiveStatus(poll.status, poll.deadline_at, now),
      deadlineAt: poll.deadline_at,
      timezone: poll.timezone,
      timezoneSet: poll.timezone_set === 1,
      targetType: poll.target_type,
      targetId: poll.target_id,
      joinPolicy: poll.join_policy,
      fixedSlotId: poll.fixed_slot_id,
      fixedAt: poll.fixed_at,
      choicesVersion: poll.choices_version,
      updatedAt: poll.updated_at,
      messageUrl: poll.message_id ? messageLink(poll.guild_id, poll.channel_id, poll.message_id) : null,
      lastSyncedAt: isOrganizer ? poll.last_synced_at : null,
      pendingChanges: pending,
      nextAutoSyncAt: isOrganizer ? nextCronAt(now) : null,
      hasEvent: poll.discord_event_id !== null,
    },
    me: { userId: session.user_id, role: session.role, isParticipant: !!me, displayName: me?.display_name ?? null, comment: me?.comment ?? null },
    slots: slots.map((s) => ({ id: s.id, startAt: s.start_at, endAt: s.end_at, allDay: s.all_day === 1 })),
    choices: choices.map((ch) => ({ id: ch.id, symbol: ch.symbol, label: ch.label, kind: ch.kind, score: ch.score, color: ch.color })),
    participants: participants.map((p) => ({ userId: p.user_id, displayName: p.display_name, comment: p.comment, answeredAt: p.answered_at })),
    answers: answers.map((a) => ({ slotId: a.slot_id, userId: a.user_id, choiceId: a.choice_id, prevChoiceId: a.prev_choice_id, updatedAt: a.updated_at })),
  });
});

polls.patch("/:id", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, PatchPollBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (body.updatedAt !== undefined && body.updatedAt !== poll.updated_at) {
    throw new AppError(409, "conflict", "ほかの画面で変更されています。画面を再読み込みしてください。");
  }
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.title !== undefined) {
    sets.push("title = ?");
    binds.push(body.title);
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    binds.push(body.description && body.description.trim() ? body.description.trim() : null);
  }
  if (body.deadlineAt !== undefined) {
    if (body.deadlineAt < now - DAY || body.deadlineAt > now + 365 * DAY) throw new AppError(400, "invalid", "締切は今日から 1 年以内にしてください。");
    sets.push("deadline_at = ?");
    binds.push(body.deadlineAt);
    if (poll.status === "closed" && body.deadlineAt > now) {
      sets.push("status = 'open'");
    }
    if (poll.status !== "draft" && poll.status !== "fixed") {
      sets.push("purge_after = ?");
      binds.push(body.deadlineAt + RETENTION);
    }
  }
  if (body.timezone !== undefined) {
    if (!isValidTimeZone(body.timezone)) throw new AppError(400, "invalid", "タイムゾーンが正しくありません。");
    // 主催者が選んだとき（timezoneAuto でないとき）は、以後ブラウザのタイムゾーンで上書きしない
    if (!body.timezoneAuto || poll.timezone_set === 0) {
      sets.push("timezone = ?", "timezone_set = ?");
      binds.push(body.timezone, body.timezoneAuto ? 0 : 1);
    }
  }
  if (body.joinPolicy !== undefined) {
    sets.push("join_policy = ?");
    binds.push(body.joinPolicy);
  }
  let notice: string | null = null;
  if (body.members !== undefined || body.roleId !== undefined) {
    if (poll.status !== "draft") throw new AppError(409, "published", "公開後は参加者の決め方を変えられません。参加者の追加・削除をお使いください。");
    const members = body.members ?? (poll.target_type === "manual" ? "manual" : "auto");
    const roleId = body.roleId !== undefined ? body.roleId : poll.target_id;
    notice = (await resetParticipants(c.env, poll, members, members === "manual" ? null : roleId)).notice;
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    binds.push(now);
    await db.prepare(`UPDATE polls SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, poll.id).run();
  }
  if (poll.status !== "draft" && (body.title !== undefined || body.description !== undefined || body.deadlineAt !== undefined)) {
    c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  }
  return c.json({ ok: true, notice });
});

polls.put("/:id/slots", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, SlotsBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (body.updatedAt !== undefined && body.updatedAt !== poll.updated_at) {
    throw new AppError(409, "conflict", "ほかの画面で変更されています。画面を再読み込みしてください。");
  }
  const existing = await getSlots(db, poll.id);
  const existingIds = new Set(existing.map((s) => s.id));
  const seen = new Set<string>();
  for (const s of body.slots) {
    if (s.id && !existingIds.has(s.id)) throw new AppError(400, "invalid", "候補が見つかりません。画面を再読み込みしてください。");
    if (s.endAt !== null && s.endAt <= s.startAt) throw new AppError(400, "invalid", "終了は開始より後にしてください。");
    if (s.startAt < now - 366 * DAY || s.startAt > now + 2 * 365 * DAY) throw new AppError(400, "invalid", "候補の日時が範囲外です。");
    const key = `${s.startAt}-${s.endAt}`;
    if (seen.has(key)) throw new AppError(400, "invalid", "同じ候補が重複しています。");
    seen.add(key);
  }
  const keepIds = new Set(body.slots.filter((s) => s.id).map((s) => s.id!));
  if (poll.fixed_slot_id && !keepIds.has(poll.fixed_slot_id)) throw new AppError(409, "fixed_slot", "確定した候補は削除できません。");
  const sorted = [...body.slots].sort((a, b) => a.startAt - b.startAt);
  const stmts: D1PreparedStatement[] = [];
  for (const old of existing) {
    if (!keepIds.has(old.id)) {
      stmts.push(db.prepare("DELETE FROM answers WHERE slot_id = ?").bind(old.id));
      stmts.push(db.prepare("DELETE FROM slots WHERE id = ?").bind(old.id));
    }
  }
  // UNIQUE 制約にぶつからないよう、残す候補はいったん仮の位置・時刻にずらしてから書き換える
  sorted.forEach((s, i) => {
    if (s.id) stmts.push(db.prepare("UPDATE slots SET start_at = ?, end_at = ?, position = ? WHERE id = ?").bind(-1 - i, null, i, s.id));
  });
  sorted.forEach((s, i) => {
    if (s.id) {
      stmts.push(db.prepare("UPDATE slots SET start_at = ?, end_at = ?, all_day = ?, position = ? WHERE id = ?").bind(s.startAt, s.endAt, s.allDay ? 1 : 0, i, s.id));
    } else {
      stmts.push(
        db.prepare("INSERT INTO slots (id, poll_id, start_at, end_at, all_day, position) VALUES (?, ?, ?, ?, ?, ?)").bind(randomId(), poll.id, s.startAt, s.endAt, s.allDay ? 1 : 0, i),
      );
    }
  });
  stmts.push(db.prepare("UPDATE polls SET updated_at = ? WHERE id = ?").bind(now, poll.id));
  await db.batch(stmts);
  if (poll.status !== "draft") c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  return c.json({ ok: true, updatedAt: now });
});

polls.put("/:id/choices", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, ChoicesBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  const status = effectiveStatus(poll.status, poll.deadline_at, now);
  if (status === "closed" || status === "fixed") throw new AppError(409, "locked", "締切後・確定後は選択肢を変更できません。");
  if (body.choicesVersion !== poll.choices_version) throw new AppError(409, "conflict", "選択肢がほかの画面で変更されています。画面を再読み込みしてください。");
  const kinds = new Set(body.choices.map((ch) => ch.kind));
  if (!kinds.has("ok") || !kinds.has("ng")) throw new AppError(400, "invalid", "「参加できる」と「参加できない」の選択肢をそれぞれ 1 つ以上入れてください。");
  const labels = new Set(body.choices.map((ch) => ch.label));
  if (labels.size !== body.choices.length) throw new AppError(400, "invalid", "選択肢の名前が重複しています。");

  const existing = await getChoices(db, poll.id);
  const existingIds = new Set(existing.map((ch) => ch.id));
  for (const ch of body.choices) if (ch.id && !existingIds.has(ch.id)) throw new AppError(400, "invalid", "選択肢が見つかりません。画面を再読み込みしてください。");
  const keepIds = new Set(body.choices.filter((ch) => ch.id).map((ch) => ch.id!));
  const removed = existing.filter((ch) => !keepIds.has(ch.id));
  const used = await db.prepare("SELECT choice_id, COUNT(*) AS n FROM answers WHERE poll_id = ? GROUP BY choice_id").bind(poll.id).all<{ choice_id: string; n: number }>();
  const usedIds = new Set(used.results.filter((u) => u.n > 0).map((u) => u.choice_id));
  const reassign = new Map(body.reassign.map((r) => [r.from, r.to]));
  for (const r of removed) {
    if (usedIds.has(r.id)) {
      const to = reassign.get(r.id);
      if (!to || !keepIds.has(to)) throw new AppError(400, "reassign_required", "回答がある選択肢を削除するときは、回答の移し先を選んでください。");
    }
  }
  const stmts: D1PreparedStatement[] = [];
  // 仮の名前にしてから書き換え（名前の UNIQUE 制約のため）
  existing.forEach((ch, i) => stmts.push(db.prepare("UPDATE choices SET label = ? WHERE id = ?").bind(`~${i}`, ch.id)));
  for (const r of removed) {
    const to = reassign.get(r.id);
    if (to) stmts.push(db.prepare("UPDATE answers SET choice_id = ?, updated_at = ? WHERE choice_id = ?").bind(to, now, r.id));
    stmts.push(db.prepare("UPDATE answers SET prev_choice_id = NULL WHERE prev_choice_id = ?").bind(r.id));
    stmts.push(db.prepare("DELETE FROM choices WHERE id = ?").bind(r.id));
  }
  body.choices.forEach((ch, i) => {
    if (ch.id) {
      stmts.push(
        db.prepare("UPDATE choices SET symbol = ?, label = ?, kind = ?, score = ?, color = ?, position = ? WHERE id = ?").bind(ch.symbol, ch.label, ch.kind, ch.score, ch.color, i, ch.id),
      );
    } else {
      stmts.push(...insertChoiceStatements(db, poll.id, [ch]));
    }
  });
  stmts.push(db.prepare("UPDATE polls SET choices_version = choices_version + 1, updated_at = ? WHERE id = ?").bind(now, poll.id));
  await db.batch(stmts);
  // 新しく追加した選択肢の position を、送られてきた順にそろえる
  const after = await getChoices(db, poll.id);
  const order = body.choices.map((ch) => ch.label);
  await db.batch(after.map((ch) => db.prepare("UPDATE choices SET position = ? WHERE id = ?").bind(order.indexOf(ch.label), ch.id)));
  if (poll.status !== "draft") c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  return c.json({ ok: true, choicesVersion: poll.choices_version + 1 });
});

polls.get("/:id/member-search", async (c) => {
  requireOrganizer(c);
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 1 || q.length > 32) return c.json({ members: [] });
  if (!(await hitRateLimit(c.env.DB, `search:${c.var.session.user_id}`, 60, 600, nowSec()))) {
    throw new AppError(429, "rate_limited", "検索の回数が多すぎます。少し待ってからお試しください。");
  }
  try {
    const members = await searchMembers(c.env, c.var.poll.guild_id, q);
    return c.json({ members });
  } catch (e) {
    if (e instanceof DiscordError && e.status === 403) throw new AppError(502, "discord_forbidden", "Bot にメンバーを検索する権限がありません。");
    throw e;
  }
});

polls.get("/:id/roles", async (c) => {
  requireOrganizer(c);
  const roles = await discord<DiscordRole[]>(c.env, "GET", `/guilds/${c.var.poll.guild_id}/roles`);
  return c.json({
    roles: roles
      .filter((r) => r.id !== c.var.poll.guild_id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name.slice(0, 100) })),
  });
});

polls.get("/:id/voice-channels", async (c) => {
  requireOrganizer(c);
  const channels = await discord<DiscordChannel[]>(c.env, "GET", `/guilds/${c.var.poll.guild_id}/channels`);
  return c.json({
    channels: channels.filter((ch) => ch.type === 2 || ch.type === 13).map((ch) => ({ id: ch.id, name: (ch.name ?? "").slice(0, 100) })),
  });
});

polls.put("/:id/participants", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, ParticipantsBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const current = await getParticipants(db, poll.id);
  const currentIds = new Set(current.map((p) => p.user_id));
  const toAdd = body.add.filter((id) => !currentIds.has(id));
  if (current.length - body.remove.length + toAdd.length > LIMITS.participantsMax) {
    throw new AppError(400, "too_many", `参加者は ${LIMITS.participantsMax} 人までです。`);
  }
  const added = [];
  for (const id of toAdd) {
    const m = await fetchMember(c.env, poll.guild_id, id);
    if (m) added.push(m);
  }
  const stmts: D1PreparedStatement[] = [];
  for (const id of body.remove) {
    stmts.push(db.prepare("DELETE FROM answers WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
    stmts.push(db.prepare("DELETE FROM participants WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
    // 外された人は、その時点で画面を開けなくする（主催者自身のセッションは残す）
    if (id !== poll.organizer_id) {
      stmts.push(db.prepare("DELETE FROM sessions WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
      stmts.push(db.prepare("DELETE FROM link_tokens WHERE poll_id = ? AND user_id = ?").bind(poll.id, id));
    }
  }
  for (const m of added) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO participants (poll_id, user_id, display_name) VALUES (?, ?, ?)").bind(poll.id, m.userId, m.displayName));
  }
  stmts.push(db.prepare("UPDATE polls SET updated_at = ? WHERE id = ?").bind(nowSec(), poll.id));
  await db.batch(stmts);
  if (poll.status !== "draft") c.executionCtx.waitUntil(syncNow(c.env, poll.id));
  return c.json({ ok: true, added: added.length, notFound: toAdd.length - added.length });
});

polls.post("/:id/publish", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (poll.status !== "draft") throw new AppError(409, "published", "この調整はすでに公開されています。");
  if (!poll.title) throw new AppError(400, "no_title", "タイトルを入力してください。");
  const [slots, choices, participants] = await Promise.all([getSlots(db, poll.id), getChoices(db, poll.id), getParticipants(db, poll.id)]);
  if (slots.length === 0) throw new AppError(400, "no_slots", "候補日時を 1 件以上入れてください。");
  if (participants.length === 0) throw new AppError(400, "no_participants", "参加者を 1 人以上入れてください。");
  const deadlineAt = poll.deadline_at && poll.deadline_at > now ? poll.deadline_at : now + DEFAULT_DEADLINE_DAYS * DAY;
  const published: PollRow = { ...poll, status: "open", deadline_at: deadlineAt };
  let messageId: string;
  try {
    const msg = buildPollMessage({ poll: published, slots, choices, participants, answers: [], now });
    const res = await discord<{ id: string }>(c.env, "POST", `/channels/${poll.channel_id}/messages`, msg);
    messageId = res.id;
  } catch (e) {
    if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
      throw new AppError(502, "discord_forbidden", "チャンネルに投稿できませんでした。Bot がこのチャンネルを見る権限・メッセージを送信する権限を持っているか確認してください。");
    }
    throw e;
  }
  await db
    .prepare("UPDATE polls SET status = 'open', deadline_at = ?, message_id = ?, last_synced_at = ?, updated_at = ?, purge_after = ? WHERE id = ? AND status = 'draft'")
    .bind(deadlineAt, messageId, now, now, deadlineAt + RETENTION, poll.id)
    .run();
  return c.json({ ok: true, redirect: `/p/${poll.id}/done?kind=published` });
});

polls.put("/:id/answers/me", async (c) => {
  const body = await readJson(c, AnswersBody);
  const { poll, session } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  const status = effectiveStatus(poll.status, poll.deadline_at, now);
  if (poll.status === "draft") throw new AppError(403, "draft", "この調整はまだ公開されていません。");
  if (!canAnswer(status)) throw new AppError(409, "closed", "この調整にはいま回答できません。");
  const me = await getParticipant(db, poll.id, session.user_id);
  if (!me) throw new AppError(403, "not_participant", "この調整の参加者ではないため、回答できません。");
  if (body.choicesVersion !== poll.choices_version) throw new AppError(409, "choices_changed", "選択肢が変更されました。画面を再読み込みしてから入力し直してください。");
  if (!(await hitRateLimit(db, `answer:${session.user_id}`, 30, 600, now))) {
    throw new AppError(429, "rate_limited", "保存の回数が多すぎます。少し待ってからお試しください。");
  }
  const [slots, choices, existing] = await Promise.all([
    getSlots(db, poll.id),
    getChoices(db, poll.id),
    db.prepare("SELECT * FROM answers WHERE poll_id = ? AND user_id = ?").bind(poll.id, session.user_id).all<{ slot_id: string; choice_id: string; prev_choice_id: string | null }>(),
  ]);
  const slotIds = new Set(slots.map((s) => s.id));
  const choiceIds = new Set(choices.map((ch) => ch.id));
  const seen = new Set<string>();
  for (const a of body.answers) {
    if (!slotIds.has(a.slotId) || !choiceIds.has(a.choiceId)) throw new AppError(400, "invalid", "候補または選択肢が見つかりません。画面を再読み込みしてください。");
    if (seen.has(a.slotId)) throw new AppError(400, "invalid", "同じ候補への回答が重複しています。");
    seen.add(a.slotId);
  }
  const old = new Map(existing.results.map((r) => [r.slot_id, r]));
  const isFixed = poll.status === "fixed";
  const stmts: D1PreparedStatement[] = [];
  for (const a of body.answers) {
    const prev = old.get(a.slotId);
    if (prev && prev.choice_id === a.choiceId) continue;
    // 確定後に変えた場合は、確定時点の選択肢を残す（元に戻したら消す）
    let prevChoice: string | null = prev?.prev_choice_id ?? null;
    if (isFixed) {
      const atFix = prev ? (prev.prev_choice_id ?? prev.choice_id) : null;
      prevChoice = atFix === a.choiceId ? null : (atFix ?? "none");
    }
    stmts.push(
      db
        .prepare(
          "INSERT INTO answers (poll_id, slot_id, user_id, choice_id, prev_choice_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(slot_id, user_id) DO UPDATE SET choice_id = excluded.choice_id, prev_choice_id = excluded.prev_choice_id, updated_at = excluded.updated_at",
        )
        .bind(poll.id, a.slotId, session.user_id, a.choiceId, prevChoice === "none" ? null : prevChoice, now),
    );
  }
  for (const [slotId] of old) {
    if (!seen.has(slotId)) stmts.push(db.prepare("DELETE FROM answers WHERE slot_id = ? AND user_id = ?").bind(slotId, session.user_id));
  }
  stmts.push(
    db.prepare("UPDATE participants SET comment = ?, answered_at = ? WHERE poll_id = ? AND user_id = ?").bind(body.comment || null, body.answers.length > 0 ? now : null, poll.id, session.user_id),
  );
  await db.batch(stmts);
  // 確定後は 1 日 2 回の Cron と手動更新に任せる（§5.5）
  if (!isFixed) c.executionCtx.waitUntil(syncAfterAnswer(c.env, poll.id));
  return c.json({ ok: true });
});

polls.post("/:id/fix", async (c) => {
  requireOrganizer(c);
  const body = await readJson(c, FixBody);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (!canAnswer(poll.status)) throw new AppError(409, "not_published", "公開中の調整だけ確定できます。");
  const slots = await getSlots(db, poll.id);
  const slot = slots.find((s) => s.id === body.slotId);
  if (!slot) throw new AppError(400, "invalid", "候補が見つかりません。");

  await db.batch([
    db.prepare("UPDATE answers SET prev_choice_id = NULL WHERE poll_id = ?").bind(poll.id),
    db
      .prepare("UPDATE polls SET status = 'fixed', fixed_slot_id = ?, fixed_at = ?, updated_at = ?, purge_after = ? WHERE id = ?")
      .bind(slot.id, now, now, Math.max(slot.start_at, now) + RETENTION, poll.id),
  ]);
  const warnings: string[] = [];
  await syncNow(c.env, poll.id).catch(() => warnings.push("募集メッセージを更新できませんでした。"));

  const participants = await getParticipants(db, poll.id);
  const title = escapeMarkdown(poll.title ?? "日程調整");
  const when = slot.all_day ? `<t:${slot.start_at}:D>（終日）` : `<t:${slot.start_at}:F>`;
  const announce = body.mention
    ? buildMentionMessage(`**${title}** の日程が確定しました: ${when}`, participants.map((p) => p.user_id))
    : { content: `**${title}** の日程が確定しました: ${when}`, allowed_mentions: { parse: [] } };
  await discord(c.env, "POST", `/channels/${poll.channel_id}/messages`, announce).catch(() => warnings.push("確定のお知らせを投稿できませんでした。"));

  if (body.event) {
    const err = await upsertEvent(c.env, poll, slot, body.event);
    if (err) warnings.push(err);
  }
  return c.json({ ok: true, redirect: `/p/${poll.id}/done?kind=fixed`, warnings });
});

async function upsertEvent(
  env: Env,
  poll: PollRow,
  slot: { start_at: number; end_at: number | null; all_day: number },
  ev: { type: "voice" | "external"; channelId: string | null; location: string | null },
): Promise<string | null> {
  const now = nowSec();
  if (slot.start_at <= now + 60) return "開始日時が過ぎているため、Discord イベントは登録しませんでした。";
  const end = slot.end_at ?? slot.start_at + (slot.all_day ? DAY : 3600);
  const payload: Record<string, unknown> = {
    name: (poll.title ?? "日程調整").slice(0, 100),
    description: (poll.description ?? "").slice(0, 1000) || undefined,
    privacy_level: 2,
    scheduled_start_time: new Date(slot.start_at * 1000).toISOString(),
    scheduled_end_time: new Date(end * 1000).toISOString(),
  };
  if (ev.type === "voice") {
    if (!ev.channelId) return "ボイスチャンネルが選ばれていないため、Discord イベントは登録しませんでした。";
    payload.entity_type = 2;
    payload.channel_id = ev.channelId;
  } else {
    payload.entity_type = 3;
    payload.channel_id = null;
    payload.entity_metadata = { location: ev.location ?? "Discord" };
  }
  try {
    if (poll.discord_event_id) {
      await discord(env, "PATCH", `/guilds/${poll.guild_id}/scheduled-events/${poll.discord_event_id}`, payload);
    } else {
      const res = await discord<{ id: string }>(env, "POST", `/guilds/${poll.guild_id}/scheduled-events`, payload);
      await env.DB.prepare("UPDATE polls SET discord_event_id = ? WHERE id = ?").bind(res.id, poll.id).run();
    }
    return null;
  } catch (e) {
    if (e instanceof DiscordError && e.status === 404 && poll.discord_event_id) {
      await env.DB.prepare("UPDATE polls SET discord_event_id = NULL WHERE id = ?").bind(poll.id).run();
      return upsertEvent(env, { ...poll, discord_event_id: null }, slot, ev);
    }
    if (e instanceof DiscordError && e.status === 403) return "Bot に「イベントの作成」権限がないため、Discord イベントは登録しませんでした。";
    return "Discord イベントを登録できませんでした。";
  }
}

polls.post("/:id/remind", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  const db = c.env.DB;
  const now = nowSec();
  if (poll.status === "draft") throw new AppError(409, "draft", "公開してからリマインドしてください。");
  if (poll.last_reminded_at && now - poll.last_reminded_at < 12 * 3600) {
    throw new AppError(429, "rate_limited", "リマインドは 12 時間に 1 回までです。");
  }
  const rows = await db
    .prepare("SELECT user_id FROM participants p WHERE poll_id = ? AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.poll_id = p.poll_id AND a.user_id = p.user_id)")
    .bind(poll.id)
    .all<{ user_id: string }>();
  if (rows.results.length === 0) return c.json({ ok: true, count: 0 });
  const r = await db.prepare("UPDATE polls SET last_reminded_at = ? WHERE id = ? AND (last_reminded_at IS NULL OR last_reminded_at <= ?)").bind(now, poll.id, now - 12 * 3600).run();
  if (r.meta.changes !== 1) throw new AppError(429, "rate_limited", "リマインドは 12 時間に 1 回までです。");
  const link = poll.message_id ? `\n${messageLink(poll.guild_id, poll.channel_id, poll.message_id)}` : "";
  const deadline = poll.deadline_at ? `（締切 <t:${poll.deadline_at}:f>）` : "";
  await discord(
    c.env,
    "POST",
    `/channels/${poll.channel_id}/messages`,
    buildMentionMessage(`**${escapeMarkdown(poll.title ?? "日程調整")}** の回答をお願いします${deadline}。募集メッセージの［回答する］から入力できます。${link}`, rows.results.map((x) => x.user_id)),
  );
  return c.json({ ok: true, count: rows.results.length });
});

polls.post("/:id/sync-message", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  if (!poll.message_id) throw new AppError(409, "no_message", "募集メッセージがありません（未公開か、メッセージが削除されています）。");
  if (!(await hitRateLimit(c.env.DB, `sync:${poll.id}`, 1, 60, nowSec()))) {
    throw new AppError(429, "rate_limited", "手動更新は 1 分に 1 回までです。");
  }
  const ok = await syncNow(c.env, poll.id);
  if (!ok) throw new AppError(502, "sync_failed", "募集メッセージを更新できませんでした。時間をおいてお試しください。");
  return c.json({ ok: true, lastSyncedAt: nowSec() });
});

polls.delete("/:id", async (c) => {
  requireOrganizer(c);
  const { poll } = c.var;
  if (poll.message_id) {
    await discord(c.env, "PATCH", `/channels/${poll.channel_id}/messages/${poll.message_id}`, buildDeletedMessage(poll.title)).catch(() => undefined);
  }
  await deletePollData(c.env.DB, poll.id);
  c.header("Set-Cookie", clearSessionCookie(poll.id));
  return c.json({ ok: true });
});

polls.delete("/:id/session", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE sid_hash = ?").bind(c.var.session.sid_hash).run();
  c.header("Set-Cookie", clearSessionCookie(c.var.poll.id));
  return c.json({ ok: true });
});

api.route("/polls", polls);

