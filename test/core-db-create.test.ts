// 共通の道具・DB・調整の作成・入力スキーマ・最近使った時間帯・Worker の入口
// （Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import type { Env } from "../src/core/env";
import { AppError, floorToMinute, isQuotaError, QUOTA_MESSAGE, randomId, randomToken, timingSafeEqual } from "../src/core/lib";
import {
  compareParticipants,
  deletePollData,
  getAnswers,
  getParticipants,
  hitRateLimit,
  hitRateLimitStatement,
  rateLimitAllows,
  rateLimitResetIn,
  readPollWithData,
  type ParticipantRow,
} from "../src/db";
import { createOrReuseDraft, DRAFT_TTL, resetParticipants } from "../src/polls/create";
import { ChoicesBody, FixBody, PatchPollBody, SessionBody, SlotsBody, AnswersBody, ParticipantsBody } from "../src/api/schemas";
import { getRecentTimes, mergeRanges, parseRanges, rangesFromSlots, saveRecentTimesStatement } from "../src/guilds/recent-times";
import worker, { publicOrigin, SECURITY_HEADERS } from "../src/index";
import { ALICE, BOB, call, freezeMidWindow, getReq, GUILD, jsonReq, mockDiscord, ORGANIZER, ORIGIN, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

describe("共通の道具", () => {
  it("トークンは base64url（+ / = を使わない）で、指定のバイト数の長さ", () => {
    for (let i = 0; i < 50; i++) {
      const t = randomToken(32);
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    for (let i = 0; i < 50; i++) expect(randomToken(1)).toMatch(/^[A-Za-z0-9_-]{2}$/);
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken()).toHaveLength(43);
  });
  it("定数時間比較は、長さが違えば一致しない", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("a\u0000", "a")).toBe(false);
  });
  it("D1 の無料枠のエラーだけを見分ける（原因のエラーも見る）", () => {
    expect(isQuotaError(new Error("D1_ERROR: exceeded the daily rows limit"))).toBe(true);
    expect(isQuotaError(new Error("wrapper", { cause: "D1 database quota exceeded" }))).toBe(true);
    expect(isQuotaError(new Error("D1 limit was reached"))).toBe(true);
    expect(isQuotaError(new Error("D1 limit hit"))).toBe(false);
    expect(isQuotaError(new Error("Too Many Requests to storage"))).toBe(true);
    expect(isQuotaError(new Error("quota exceeded"))).toBe(false);
    expect(isQuotaError(new Error("D1 syntax error"))).toBe(false);
    expect(isQuotaError("D1 quota")).toBe(true);
    expect(isQuotaError(new Error("x"))).toBe(false);
    expect(QUOTA_MESSAGE).toContain("日本時間 午前 9 時まで使えません。");
    expect(QUOTA_MESSAGE).toContain("入力済みの回答は消えていません。");
  });
  it("分に切り捨てる", () => {
    expect(floorToMinute(119)).toBe(60);
    expect(floorToMinute(120)).toBe(120);
  });
});

describe("DB", () => {
  const p = (user_id: string, display_name: string) => ({ user_id, display_name }) as ParticipantRow;
  it("参加者は表示名、次に ID の順", () => {
    expect(compareParticipants(p("1", "あ"), p("2", "い"))).toBeLessThan(0);
    expect(compareParticipants(p("2", "い"), p("1", "あ"))).toBeGreaterThan(0);
    expect(compareParticipants(p("2", "あ"), p("1", "あ"))).toBeGreaterThan(0);
    expect(compareParticipants(p("1", "あ"), p("1", "あ"))).toBe(0);
  });

  it("読み込みでは、候補を日時・位置、選択肢を位置、参加者を表示名の順に並べる", async () => {
    const { pollId, slotIds } = await seedPoll({ participants: [ALICE, ORGANIZER] });
    await db().prepare("UPDATE participants SET display_name = CASE user_id WHEN ? THEN 'b' ELSE 'a' END WHERE poll_id = ?").bind(ALICE, pollId).run();
    await db().prepare("UPDATE slots SET start_at = 100, position = 2 WHERE id = ?").bind(slotIds[0]).run();
    await db().prepare("UPDATE slots SET start_at = 100, position = 1 WHERE id = ?").bind(slotIds[1]).run();
    await db().prepare("UPDATE slots SET start_at = 50, position = 0 WHERE id = ?").bind(slotIds[2]).run();
    await db().prepare("UPDATE choices SET position = 5 - position WHERE poll_id = ?").bind(pollId).run();
    const d = (await readPollWithData(db(), pollId))!;
    expect(d.slots.map((s) => s.id)).toEqual([slotIds[2], slotIds[1], slotIds[0]]);
    expect(d.choices.map((c) => c.position)).toEqual([3, 4, 5]);
    expect(d.participants.map((x) => x.user_id)).toEqual([ORGANIZER, ALICE]);
    expect((await getParticipants(db(), pollId)).map((x) => x.user_id)).toEqual([ORGANIZER, ALICE]);
    expect(await readPollWithData(db(), "x".repeat(22))).toBeNull();
  });

  it("回答を読む", async () => {
    const { pollId, slotIds, choiceIds } = await seedPoll();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 1)").bind(pollId, slotIds[0], ALICE, choiceIds[0]).run();
    expect(await getAnswers(db(), pollId)).toEqual([expect.objectContaining({ slot_id: slotIds[0], user_id: ALICE, choice_id: choiceIds[0] })]);
  });

  it("調整を削除すると、関連データもすべて消え、ほかの調整は残る", async () => {
    const a = await seedPoll();
    const b = await seedPoll();
    for (const s of [a, b]) {
      await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 1)").bind(s.pollId, s.slotIds[0], ALICE, s.choiceIds[0]).run();
      await db().prepare("INSERT INTO link_tokens (token_hash, poll_id, user_id, role, purpose, expires_at) VALUES (?, ?, ?, 'participant', 'answer', 9999999999)").bind(`h-${s.pollId}`, s.pollId, ALICE).run();
      await db().prepare("INSERT INTO sessions (sid_hash, poll_id, user_id, role, csrf_token, expires_at, created_at) VALUES (?, ?, ?, 'participant', 'c', 9999999999, 0)").bind(`s-${s.pollId}`, s.pollId, ALICE).run();
    }
    await deletePollData(db(), a.pollId);
    for (const t of ["answers", "participants", "slots", "choices", "link_tokens", "sessions"]) {
      const n = async (id: string) => (await db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE poll_id = ?`).bind(id).first<{ n: number }>())!.n;
      expect(await n(a.pollId), t).toBe(0);
      expect(await n(b.pollId), t).toBeGreaterThan(0);
    }
  });

  it("回数制限は固定の区切りで数え、区切りの終わりで期限が切れる", async () => {
    const key = `t:${randomId()}`;
    const now = 7205; // 3600 秒の区切りでは 7200〜10799
    expect(await hitRateLimit(db(), key, 2, 3600, now)).toBe(true);
    expect(await hitRateLimit(db(), key, 2, 3600, now + 100)).toBe(true);
    expect(await rateLimitAllows(db(), key, 2, 3600, now)).toBe(false);
    expect(await rateLimitAllows(db(), key, 3, 3600, now)).toBe(true);
    expect(await hitRateLimit(db(), key, 2, 3600, now)).toBe(false);
    expect(await hitRateLimit(db(), key, 2, 3600, 10800)).toBe(true);
    const row = await db().prepare("SELECT key, expires_at FROM rate_limits WHERE key = ?").bind(`${key}:7200`).first();
    expect(row).toEqual({ key: `${key}:7200`, expires_at: 10800 });
    await hitRateLimitStatement(db(), `${key}b`, 3600, now).run();
    expect(await db().prepare("SELECT count, expires_at FROM rate_limits WHERE key = ?").bind(`${key}b:7200`).first()).toEqual({ count: 1, expires_at: 10800 });
    expect(await rateLimitAllows(db(), `${key}c`, 1, 3600, now)).toBe(true);
    expect(rateLimitResetIn(3600, 7205)).toBe(3595);
    expect(rateLimitResetIn(3600, 7200)).toBe(3600);
  });
});

describe("調整の作成", () => {
  const CH = "300000000000000400";
  const guildMock = (members = [ORGANIZER, ALICE], roles: Record<string, string[]> = {}) =>
    mockDiscord((c) => {
      if (c.path === `/channels/${CH}`) return { id: CH, type: 0, permission_overwrites: [] };
      if (c.path === `/guilds/${GUILD}`) return { owner_id: ORGANIZER };
      if (c.path === `/guilds/${GUILD}/roles`) return [{ id: GUILD, name: "@everyone", permissions: "1024", position: 0 }];
      if (c.path.startsWith(`/guilds/${GUILD}/members?`)) return members.map((id) => ({ user: { id, username: `u${id.slice(-2)}` }, roles: roles[id] ?? [] }));
      if (c.path.startsWith(`/guilds/${GUILD}/members/`)) return { user: { id: c.path.split("/").pop(), username: "me" }, roles: [] };
      return {};
    });
  const opts = (over: Partial<Parameters<typeof createOrReuseDraft>[1]> = {}) => ({ guildId: GUILD, channelId: CH, organizerId: ORGANIZER, title: null, members: null, roleId: null, deadlineDays: null, ...over });
  const row = (id: string) => db().prepare("SELECT * FROM polls WHERE id = ?").bind(id).first<Record<string, unknown>>();
  const people = async (id: string) => (await getParticipants(db(), id)).map((p) => p.user_id).sort();

  async function fresh() {
    await db().batch([
      db().prepare("DELETE FROM polls WHERE channel_id = ?").bind(CH),
      db().prepare("DELETE FROM rate_limits"),
      db().prepare("DELETE FROM guild_settings WHERE guild_id = ?").bind(GUILD),
    ]);
  }

  it("新しく作ると、既定の選択肢と参加者を入れ、3 日後に消える下書きにする", async () => {
    await fresh();
    guildMock();
    const r = await createOrReuseDraft(testEnv(), opts());
    if (!r.ok) throw new Error(r.message);
    expect(r).toMatchObject({ reused: false, notice: null, targetType: "channel" });
    const p = (await row(r.pollId))!;
    expect(p.purge_after).toBe((p.created_at as number) + DRAFT_TTL);
    expect(DRAFT_TTL).toBe(3 * 86400);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM choices WHERE poll_id = ?").bind(r.pollId).first<{ n: number }>();
    expect(n!.n).toBe(3);
    expect(await people(r.pollId)).toEqual([ORGANIZER, ALICE].sort());
  });

  it("オプションつきなら、未入力の下書きを使い回して内容を入れ直す。オプションがなければそのまま使い回す", async () => {
    await fresh();
    guildMock();
    const first = await createOrReuseDraft(testEnv(), opts());
    if (!first.ok) throw new Error();
    await db().prepare("UPDATE polls SET purge_after = 1 WHERE id = ?").bind(first.pollId).run();
    const same = await createOrReuseDraft(testEnv(), opts());
    expect(same).toEqual({ ok: true, pollId: first.pollId, reused: true, notice: null, targetType: "channel" });
    expect((await row(first.pollId))!.purge_after).toBe(1);
    for (const over of [{ title: "t" }, { members: "manual" as const }, { roleId: "600000000000000001" }, { deadlineDays: 3 }]) {
      await db().prepare("UPDATE polls SET title = NULL WHERE id = ?").bind(first.pollId).run();
      const again = await createOrReuseDraft(testEnv(), opts(over));
      expect(again, JSON.stringify(over)).toMatchObject({ ok: true, pollId: first.pollId, reused: true });
      expect((await row(first.pollId))!.purge_after as number).toBeGreaterThan(1);
      await db().prepare("UPDATE polls SET purge_after = 1 WHERE id = ?").bind(first.pollId).run();
    }
    // 入れ直すときは参加者も入れ直す
    const n = await db().prepare("SELECT COUNT(*) AS n FROM participants WHERE poll_id = ?").bind(first.pollId).first<{ n: number }>();
    expect(n!.n).toBeGreaterThan(0);
  });

  it("作成は 1 人 1 時間に 10 件まで。超えたら残りの分数を案内する", async () => {
    freezeMidWindow();
    await fresh();
    guildMock();
    for (let i = 0; i < 10; i++) expect((await createOrReuseDraft(testEnv(), opts({ title: `t${i}` }))).ok).toBe(true);
    const r = await createOrReuseDraft(testEnv(), opts({ title: "x" }));
    expect(r.ok).toBe(false);
    // 時計は毎時 25 分に止めてあるので、残りは 35 分
    expect((r as { message: string }).message).toBe("作成数の上限（1 時間に 10 件）に達しました。35 分後に再度お試しください。");
  });

  it("サーバー全体では 1 日 100 件まで", async () => {
    await fresh();
    guildMock();
    const now = Math.floor(Date.now() / 1000);
    await db().prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 100, ?)").bind(`create:guild:${GUILD}:${Math.floor(now / 86400) * 86400}`, now + 86400).run();
    expect(await createOrReuseDraft(testEnv(), opts({ title: "x" }))).toEqual({ ok: false, message: "このサーバー全体の作成数の上限（1 日 100 件）に達しました。明日もう一度お試しください。" });
  });

  it("チャンネルの進行中の調整は 20 件まで。未入力の下書きを使い回すときは数えない", async () => {
    await fresh();
    guildMock();
    for (let i = 0; i < 19; i++) {
      const s = await seedPoll();
      await db().prepare("UPDATE polls SET channel_id = ? WHERE id = ?").bind(CH, s.pollId).run();
    }
    const draft = await createOrReuseDraft(testEnv(), opts());
    expect(draft.ok).toBe(true);
    await db().prepare("DELETE FROM rate_limits").run();
    expect((await createOrReuseDraft(testEnv(), opts({ title: "t" }))).ok).toBe(true);
    await db().prepare("DELETE FROM rate_limits").run();
    expect(await createOrReuseDraft(testEnv(), opts({ title: "u" }))).toEqual({ ok: false, message: "このチャンネルの進行中の調整が多すぎます（20 件まで）。不要な調整を削除してください。" });
  });

  it("サーバーの既定値: 手動なら主催者だけ、ロールならロールのメンバー。誰もいなければチャンネルのメンバーにする", async () => {
    await fresh();
    const role = "600000000000000001";
    guildMock([ORGANIZER, ALICE], { [ALICE]: [role] });
    await db().prepare("INSERT INTO guild_settings (guild_id, mode, role_id, updated_by, updated_at) VALUES (?, 'manual', NULL, 'u', 0)").bind(GUILD).run();
    const manual = await createOrReuseDraft(testEnv(), opts({ title: "a" }));
    if (!manual.ok) throw new Error();
    expect(manual.targetType).toBe("manual");
    expect(await people(manual.pollId)).toEqual([ORGANIZER]);

    await db().prepare("UPDATE guild_settings SET mode = 'role', role_id = ? WHERE guild_id = ?").bind(role, GUILD).run();
    const byRole = await createOrReuseDraft(testEnv(), opts({ title: "b" }));
    if (!byRole.ok) throw new Error();
    expect(byRole).toMatchObject({ targetType: "role", notice: null });
    expect((await row(byRole.pollId))!.target_id).toBe(role);
    expect(await people(byRole.pollId)).toEqual([ALICE]);

    // コマンドで決め方を指定したら、既定値を使わない
    const explicit = await createOrReuseDraft(testEnv(), opts({ title: "c", members: "auto" }));
    if (!explicit.ok) throw new Error();
    expect(explicit.targetType).toBe("channel");

    await db().prepare("UPDATE guild_settings SET role_id = '600000000000000002' WHERE guild_id = ?").bind(GUILD).run();
    const empty = await createOrReuseDraft(testEnv(), opts({ title: "d" }));
    if (!empty.ok) throw new Error();
    expect(empty).toMatchObject({ targetType: "channel", notice: "サーバーの既定のロールを持つメンバーがいないため、このチャンネルのメンバーを参加者にしました。" });
    expect((await row(empty.pollId))!.target_id).toBeNull();

    // ロールのモードでもロールが未設定なら、チャンネル
    await db().prepare("UPDATE guild_settings SET role_id = NULL WHERE guild_id = ?").bind(GUILD).run();
    const noRole = await createOrReuseDraft(testEnv(), opts({ title: "e" }));
    expect(noRole).toMatchObject({ targetType: "channel" });
  });

  it("コマンドで指定したロールに誰もいなければ、空のままロールの調整にする", async () => {
    await fresh();
    guildMock([ORGANIZER]);
    const r = await createOrReuseDraft(testEnv(), opts({ title: "x", roleId: "600000000000000003" }));
    if (!r.ok) throw new Error();
    expect(r).toMatchObject({ targetType: "role", notice: null });
    expect(await people(r.pollId)).toEqual([]);
  });

  it("参加者を取得できなければ手動に切り替え、主催者だけを入れる。主催者も取得できなければ空", async () => {
    await fresh();
    mockDiscord((c) => (c.path.startsWith(`/guilds/${GUILD}/members/${ORGANIZER}`) ? { user: { id: ORGANIZER, username: "me" }, roles: [] } : new Response("{}", { status: 500 })));
    const r = await createOrReuseDraft(testEnv(), opts({ title: "x" }));
    if (!r.ok) throw new Error();
    expect(r).toMatchObject({ targetType: "manual", notice: "参加者を自動で設定できませんでした。手動で参加者を選んでください。" });
    expect(await people(r.pollId)).toEqual([ORGANIZER]);
    vi.restoreAllMocks();
    mockDiscord(() => new Response("{}", { status: 500 }));
    const r2 = await createOrReuseDraft(testEnv(), opts({ title: "y", members: "manual" }));
    if (!r2.ok) throw new Error();
    expect(await people(r2.pollId)).toEqual([]);
  });

  it("下書きの参加者の決め方を変えると、回答と参加者を入れ直す", async () => {
    await fresh();
    guildMock();
    const { pollId, slotIds, choiceIds } = await seedPoll({ status: "draft", participants: [BOB] });
    await db().prepare("UPDATE polls SET channel_id = ? WHERE id = ?").bind(CH, pollId).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 1)").bind(pollId, slotIds[0], BOB, choiceIds[0]).run();
    const poll = (await row(pollId)) as unknown as Parameters<typeof resetParticipants>[1];
    expect(await resetParticipants(testEnv(), poll, "auto", null)).toEqual({ notice: null, targetType: "channel" });
    expect(await people(pollId)).toEqual([ORGANIZER, ALICE].sort());
    expect(await getAnswers(db(), pollId)).toEqual([]);
    expect(await resetParticipants(testEnv(), poll, "manual", null)).toEqual({ notice: null, targetType: "manual" });
    expect(await people(pollId)).toEqual([ORGANIZER]);
    expect((await row(pollId))!.target_type).toBe("manual");
    vi.restoreAllMocks();
    mockDiscord(() => new Response("{}", { status: 500 }));
    await resetParticipants(testEnv(), poll, "manual", null);
    expect(await people(pollId)).toEqual([]);
  });
});

describe("入力スキーマ", () => {
  const ok = (s: v.GenericSchema, x: unknown) => v.safeParse(s, x).success;
  const msg = (s: v.GenericSchema, x: unknown) => {
    const r = v.safeParse(s, x);
    return r.success ? null : r.issues.map((i) => i.message).find((m) => !m.startsWith("Invalid")) ?? "Invalid";
  };
  const id = "A".repeat(22);

  it("ID・Discord の ID・トークンは前後に余計な文字があれば拒否する", () => {
    expect(ok(SessionBody, { token: "A".repeat(43) })).toBe(true);
    expect(ok(SessionBody, { token: "A".repeat(44) })).toBe(false);
    expect(ok(SessionBody, { token: `!${"A".repeat(43)}` })).toBe(false);
    const fix = (slotId: string, channelId: string | null = null) => ({ slotId, event: { type: "voice", channelId, location: null } });
    expect(ok(FixBody, fix(id, "12345678901234567"))).toBe(true);
    expect(ok(FixBody, fix(`${id}A`))).toBe(false);
    expect(ok(FixBody, fix(`!${id}`))).toBe(false);
    expect(ok(FixBody, fix(id, "123456789012345678901"))).toBe(false);
    expect(ok(FixBody, fix(id, "x12345678901234567"))).toBe(false);
    expect(ok(FixBody, { slotId: id, event: { type: "external", channelId: null, location: "会議室" } })).toBe(true);
    expect(ok(FixBody, { slotId: id, event: { type: "other", channelId: null, location: null } })).toBe(false);
  });

  it("1 行の文字列: 前後の空白を除いて 1〜上限の文字数。制御文字は拒否する", () => {
    expect(ok(PatchPollBody, { title: "a".repeat(100) })).toBe(true);
    expect(msg(PatchPollBody, { title: "a".repeat(101) })).toBe("1〜100 文字で入力してください");
    expect(msg(PatchPollBody, { title: "   " })).toBe("1〜100 文字で入力してください");
    expect(msg(PatchPollBody, { title: "a​" })).toBe("使えない文字が含まれています");
  });

  it("説明は 1000 文字まで、改行は使える", () => {
    expect(ok(PatchPollBody, { description: "a\n".repeat(500) })).toBe(true);
    expect(msg(PatchPollBody, { description: "a".repeat(1001) })).toBe("1000 文字以内で入力してください");
    expect(msg(PatchPollBody, { description: "a\tb" })).toBe("使えない文字が含まれています");
    expect(ok(PatchPollBody, { members: "auto", joinPolicy: "closed", remindDayOffset: 1, remindHour: 23 })).toBe(true);
    expect(ok(PatchPollBody, { members: "x" })).toBe(false);
    expect(ok(PatchPollBody, { joinPolicy: "x" })).toBe(false);
    expect(ok(PatchPollBody, { remindHour: 24 })).toBe(false);
  });

  it("候補は 30 件まで", () => {
    const s = (n: number) => ({ slots: Array.from({ length: n }, (_, i) => ({ id: null, startAt: i, endAt: null, allDay: false })) });
    expect(ok(SlotsBody, s(30))).toBe(true);
    expect(msg(SlotsBody, s(31))).toBe("候補は 30 件までです");
  });

  it("選択肢: 記号は 2 文字（書記素）・8 コードポイントまで、名前は 10 文字まで。2〜5 個", () => {
    const c = (symbol: string, label = "参加") => ({ id: null, symbol, label, kind: "ok", score: 1, color: "green" });
    const body = (choices: unknown[]) => ({ choicesVersion: 1, choices, reassign: [] });
    // 肌の色つきの絵文字は 1 書記素・2 コードポイントなので通る。2 書記素でも 8 コードポイントを超えれば通らない
    expect(ok(ChoicesBody, body([c("\u{1F44D}\u{1F3FD}"), c("×", "b")]))).toBe(true);
    const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
    expect(ok(ChoicesBody, body([c(scotland), c("×", "b")]))).toBe(true);
    expect(msg(ChoicesBody, body([c(`${scotland}1\uFE0F\u20E3`), c("×", "b")]))).toBe("長さが正しくありません");
    expect(ok(ChoicesBody, body([c("○◎"), c("×", "b")]))).toBe(true);
    expect(msg(ChoicesBody, body([c("○◎△"), c("×", "b")]))).toBe("長さが正しくありません");
    expect(msg(ChoicesBody, body([c(" "), c("×", "b")]))).toBe("長さが正しくありません");
    expect(ok(ChoicesBody, body([c("○", "a".repeat(10)), c("×", "b")]))).toBe(true);
    expect(msg(ChoicesBody, body([c("○", "a".repeat(11)), c("×", "b")]))).toBe("長さが正しくありません");
    expect(msg(ChoicesBody, body([c("@"), c("×", "b")]))).toBe("使えない文字が含まれています");
    expect(msg(ChoicesBody, body([c("○")]))).toBe("選択肢は 2 個以上にしてください");
    expect(msg(ChoicesBody, body(Array.from({ length: 6 }, (_, i) => c("○", `l${i}`))))).toBe("選択肢は 5 個までです");
  });

  it("ひとことは 100 文字まで、制御文字は使えない", () => {
    const a = (comment: string | null) => ({ choicesVersion: 1, answers: [], comment });
    expect(ok(AnswersBody, a("a".repeat(100)))).toBe(true);
    expect(ok(AnswersBody, a(null))).toBe(true);
    expect(msg(AnswersBody, a("a".repeat(101)))).toBe("100 文字以内で入力してください");
    expect(msg(AnswersBody, a("a\nb"))).toBe("使えない文字が含まれています");
  });

  it("参加者の追加は 1 回 25 人まで", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => String(10000000000000000n + BigInt(i)));
    expect(ok(ParticipantsBody, { add: ids(25), remove: [] })).toBe(true);
    expect(ok(ParticipantsBody, { add: ids(26), remove: [] })).toBe(false);
  });
});

describe("最近使った時間帯", () => {
  it("保存値は形式の正しいものだけを、3 件まで読む", () => {
    expect(parseRanges(null)).toEqual([]);
    expect(parseRanges("")).toEqual([]);
    expect(parseRanges("{")).toEqual([]);
    expect(parseRanges('{"start":"10:00"}')).toEqual([]);
    const r = (start: unknown, end: unknown) => ({ start, end, extra: 1 });
    expect(
      parseRanges(JSON.stringify([r("10:00", "11:00"), null, 5, r("x10:00", "11:00"), r("10:00", "11:00x"), r("24:00", "11:00"), r("09:60", "11:00"), r(1, "11:00"), r("10:00", 2), r("23:59", "00:00"), r("20:00", "21:00"), r("08:00", "09:00")])),
    ).toEqual([
      { start: "10:00", end: "11:00" },
      { start: "23:59", end: "00:00" },
      { start: "20:00", end: "21:00" },
    ]);
  });

  it("候補から時間帯を取り出す（終日・終了なしは除き、重複は 1 つ）", () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    const s = (start: string, end: string | null, allDay = false) => ({ startAt: at(start), endAt: end ? at(end) : null, allDay });
    expect(
      rangesFromSlots(
        [
          s("2026-11-12T11:05:00Z", "2026-11-12T13:00:00Z"),
          s("2026-11-13T11:05:00Z", "2026-11-13T13:00:00Z"),
          s("2026-11-13T11:05:00Z", "2026-11-13T14:00:00Z"),
          s("2026-11-13T10:05:00Z", "2026-11-13T13:00:00Z"),
          s("2026-11-14T00:00:00Z", "2026-11-14T01:00:00Z", true),
          s("2026-11-14T00:00:00Z", null),
        ],
        "Asia/Tokyo",
      ),
    ).toEqual([
      { start: "20:05", end: "22:00" },
      { start: "20:05", end: "23:00" },
      { start: "19:05", end: "22:00" },
    ]);
  });

  it("新しいものを先頭にして、重複を除いて 3 件まで", () => {
    const r = (start: string, end: string) => ({ start, end });
    expect(mergeRanges([r("10:00", "11:00")], [r("10:00", "12:00"), r("09:00", "11:00"), r("10:00", "11:00"), r("08:00", "09:00")])).toEqual([
      r("10:00", "11:00"),
      r("10:00", "12:00"),
      r("09:00", "11:00"),
    ]);
    expect(mergeRanges([r("1", "2"), r("1", "2")], [])).toEqual([r("1", "2")]);
  });

  it("保存して読み直せる", async () => {
    const g = "200000000000000321";
    await saveRecentTimesStatement(db(), g, [{ start: "10:00", end: "11:00" }], 5).run();
    await saveRecentTimesStatement(db(), g, [{ start: "12:00", end: "13:00" }], 6).run();
    expect(await getRecentTimes(db(), g)).toEqual([{ start: "12:00", end: "13:00" }]);
    expect(await getRecentTimes(db(), "200000000000000322")).toEqual([]);
  });
});

describe("Worker の入口", () => {
  it("すべての応答にセキュリティヘッダーを付ける", async () => {
    const res = await call(getReq("/nothing"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    for (const [k, val] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k), k).toBe(val);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains; preload");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toContain("camera=()");
    expect(SECURITY_HEADERS["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(SECURITY_HEADERS["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });

  it("正式なアドレス以外は転送する。Discord からの POST だけはそのまま受ける", async () => {
    const e = testEnv({ PUBLIC_ORIGIN: "https://canonical.example" });
    const get = await call(getReq("/p/x?y=1"), e);
    expect(get.status).toBe(301);
    expect(get.headers.get("Location")).toBe("https://canonical.example/p/x?y=1");
    const head = await call(new Request(`${ORIGIN}/a`, { method: "HEAD" }), e);
    expect(head.status).toBe(301);
    const post = await call(jsonReq("POST", "/api/session", {}), e);
    expect(post.status).toBe(404);
    expect(await post.text()).toBe("Not Found");
    const discordPost = await call(new Request(`${ORIGIN}/discord/interactions`, { method: "POST", body: "{}" }), e);
    expect(discordPost.status).toBe(401);
    expect(await discordPost.text()).toBe("invalid request signature");
    // 正式なアドレスへのアクセスは転送しない
    expect((await call(new Request("https://canonical.example/nothing"), e)).status).toBe(404);
    expect(publicOrigin(e, `${ORIGIN}/x`)).toBe("https://canonical.example");
    expect(publicOrigin(testEnv({ PUBLIC_ORIGIN: "" }), `${ORIGIN}/x`)).toBe(ORIGIN);
  });

  it("Web 画面のページは、どれも同じ HTML を返す。読めなければ 500", async () => {
    const fetchAsset = vi.fn(async (req: Request) => (new URL(req.url).pathname === "/app/" ? new Response("<html>app</html>") : new Response("", { status: 404 })));
    const e = testEnv({ ASSETS: { fetch: fetchAsset } as unknown as Fetcher });
    for (const path of ["/l", `/p/${"A".repeat(22)}`, `/p/${"A".repeat(22)}/edit`, `/p/${"A".repeat(22)}/answer`, `/p/${"A".repeat(22)}/done`, `/g/${GUILD}/polls`]) {
      const res = await call(getReq(path), e);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toBe("<html>app</html>");
    }
    expect((await call(getReq(`/p/${"A".repeat(22)}/other`), e)).status).toBe(404);
    const broken = testEnv({ ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher });
    expect((await call(getReq("/l"), broken)).status).toBe(500);
  });

  it("想定外のエラーは参照番号つきで 500、D1 の無料枠のエラーは 503", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db(), "prepare").mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await call(jsonReq("POST", "/api/session", { token: "A".repeat(43) }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toMatch(/^エラーが発生しました。時間をおいてもう一度お試しください（参照番号: [A-Za-z0-9_-]{8}）。$/);
    const ref = body.error.message.match(/参照番号: ([^）]+)/)![1];
    expect(err).toHaveBeenCalledWith(JSON.stringify({ event: "unhandled_error", ref, error: "boom" }));

    vi.restoreAllMocks();
    vi.spyOn(db(), "prepare").mockImplementation(() => {
      throw new Error("D1_ERROR: exceeded daily rows limit");
    });
    const q = await call(jsonReq("POST", "/api/session", { token: "A".repeat(43) }));
    expect(q.status).toBe(503);
    expect(await q.json()).toEqual({ error: { code: "free_tier_exceeded", message: QUOTA_MESSAGE } });
  });

  it("アプリのエラーは、そのままの状態コードと文で返す", async () => {
    const res = await call(getReq(`/api/polls/${"A".repeat(22)}`));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_session");
    expect(new AppError(418, "x", "y")).toMatchObject({ status: 418, code: "x", message: "y" });
  });

  it("Cron の呼び出しを処理に渡す", async () => {
    mockDiscord(() => []);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    await worker.scheduled!({ scheduledTime: Date.parse("2026-11-06T04:00:00Z"), cron: "0 4 * * *", noRetry() {} } as ScheduledController, testEnv(), {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    expect(pending).toHaveLength(1);
    await pending[0];
  });
});

