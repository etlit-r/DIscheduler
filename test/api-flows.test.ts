// Web API の公開・回答・確定・お知らせ・リマインド・投稿し直し・削除・一覧
// （Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { issueListLink } from "../src/auth";
import { DAY, nowSec } from "../src/core/lib";
import { RETENTION } from "../src/polls/create";
import { ALICE, BOB, call, CHANNEL, errorOf, freezeMidWindow, getReq, GUILD, jsonReq, login, mockDiscord, ORGANIZER, ORIGIN, pollRow, seedPoll, testEnv, tokenFromUrl, type DiscordCall } from "./helpers";

const db = () => (env as unknown as Env).DB;
const slotRow = (id: string) => db().prepare("SELECT * FROM slots WHERE id = ?").bind(id).first<Record<string, unknown>>();
afterEach(() => vi.restoreAllMocks());

async function organizer(opts: Parameters<typeof seedPoll>[0] = {}, handler?: (c: DiscordCall) => unknown) {
  const calls = mockDiscord(handler);
  const s = await seedPoll(opts);
  const auth = await login(s.pollId, ORGANIZER, "organizer", "edit");
  const req = (method: string, path: string, body?: unknown) => call(jsonReq(method, `/api/polls/${s.pollId}${path}`, body, auth));
  return { ...s, calls, auth, req };
}

describe("調整の詳細", () => {
  it("主催者には更新の状況と最近の時間帯を、参加者には自分の情報を返す", async () => {
    const { pollId, slotIds, choiceIds, auth } = await organizer();
    await db().prepare("UPDATE polls SET timezone_set = 1, last_synced_at = 100, description = 'd', target_type = 'role', target_id = '6' WHERE id = ?").bind(pollId).run();
    await db().prepare("UPDATE slots SET fixed_at = 5, discord_event_id = 'e', announced_fixed = 1, all_day = 1 WHERE id = ?").bind(slotIds[0]).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, prev_choice_id, updated_at) VALUES (?, ?, ?, ?, ?, 200)").bind(pollId, slotIds[0], ALICE, choiceIds[0], choiceIds[1]).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 50)").bind(pollId, slotIds[1], ALICE, choiceIds[0]).run();
    await db().prepare("UPDATE participants SET comment = 'よろしく', answered_at = 200 WHERE poll_id = ? AND user_id = ?").bind(pollId, ALICE).run();

    const o = (await (await call(getReq(`/api/polls/${pollId}`, auth.cookie), testEnv({ DONATION_URL: "https://ko-fi.com/x" }))).json()) as Record<string, any>;
    expect(o.csrfToken).toBe(auth.csrf);
    expect(o.donationUrl).toBe("https://ko-fi.com/x");
    expect(o.poll).toMatchObject({ id: pollId, title: "定例会", description: "d", status: "open", timezoneSet: true, targetType: "role", targetId: "6", joinPolicy: "closed", choicesVersion: 1, messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/500000000000000001`, lastSyncedAt: 100, pendingChanges: 1, remindDayOffset: 0, remindHour: 17 });
    expect(o.poll.nextAutoSyncAt).toBeGreaterThan(o.now);
    expect(o.me).toEqual({ userId: ORGANIZER, role: "organizer", isParticipant: true, displayName: "user-01", comment: null, answeredAt: null, needsChoicesAck: false });
    expect(o.slots[0]).toEqual({ id: slotIds[0], startAt: expect.any(Number), endAt: expect.any(Number), allDay: true, fixedAt: 5, hasEvent: true, announced: true });
    expect(o.slots[1]).toMatchObject({ allDay: false, fixedAt: null, hasEvent: false, announced: false });
    expect(o.choices[0]).toEqual({ id: choiceIds[0], symbol: "○", label: "参加", kind: "ok", score: 4, color: "green" });
    expect(o.participants).toContainEqual({ userId: ALICE, displayName: "user-02", comment: "よろしく", answeredAt: 200 });
    expect(o.answers).toContainEqual({ slotId: slotIds[0], userId: ALICE, choiceId: choiceIds[0], prevChoiceId: choiceIds[1], updatedAt: 200 });
    expect(o.recentTimes).toEqual([]);

    const alice = await login(pollId, ALICE, "participant", "answer");
    const p = (await (await call(getReq(`/api/polls/${pollId}`, alice.cookie), testEnv({ DONATION_URL: "javascript:alert(1)" }))).json()) as Record<string, any>;
    expect(p.donationUrl).toBeNull();
    expect(p.poll).toMatchObject({ lastSyncedAt: null, pendingChanges: null, nextAutoSyncAt: null });
    expect(p.me).toMatchObject({ isParticipant: true, displayName: "user-02", comment: "よろしく", answeredAt: 200 });
  });

  it("回答のあとで選択肢が変わり、まだ確認していなければ知らせる。確認すれば消える", async () => {
    const { pollId, slotIds, choiceIds } = await organizer();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 100)").bind(pollId, slotIds[0], ALICE, choiceIds[0]).run();
    await db().prepare("UPDATE participants SET answered_at = 100 WHERE poll_id = ? AND user_id = ?").bind(pollId, ALICE).run();
    await db().prepare("UPDATE polls SET choices_changed_at = 150, choices_version = 2 WHERE id = ?").bind(pollId).run();
    const alice = await login(pollId, ALICE, "participant", "answer");
    const ack = async () => ((await (await call(getReq(`/api/polls/${pollId}`, alice.cookie))).json()) as { me: { needsChoicesAck: boolean } }).me.needsChoicesAck;
    expect(await ack()).toBe(true);
    // 回答が変更の時刻ちょうどでも、変更前の回答として扱う
    await db().prepare("UPDATE answers SET updated_at = 150 WHERE poll_id = ?").bind(pollId).run();
    expect(await ack()).toBe(true);
    // 変更のあとに回答し直していれば知らせない
    await db().prepare("UPDATE answers SET updated_at = 151 WHERE poll_id = ?").bind(pollId).run();
    expect(await ack()).toBe(false);
    await db().prepare("UPDATE answers SET updated_at = 100 WHERE poll_id = ?").bind(pollId).run();
    // 未回答なら知らせない
    await db().prepare("UPDATE participants SET answered_at = NULL WHERE poll_id = ? AND user_id = ?").bind(pollId, ALICE).run();
    expect(await ack()).toBe(false);
    await db().prepare("UPDATE participants SET answered_at = 100 WHERE poll_id = ? AND user_id = ?").bind(pollId, ALICE).run();
    const res = await call(jsonReq("POST", `/api/polls/${pollId}/choices-ack`, {}, alice));
    expect(await res.json()).toEqual({ ok: true });
    expect(await ack()).toBe(false);
    const row = await db().prepare("SELECT choices_ack_version FROM participants WHERE poll_id = ? AND user_id = ?").bind(pollId, ALICE).first<{ choices_ack_version: number }>();
    expect(row!.choices_ack_version).toBe(2);
  });

  it("参加者から外れた主催者でない人は 403。下書きは参加者には 404", async () => {
    const { pollId } = await organizer({ status: "draft", messageId: null });
    const alice = await login(pollId, ALICE, "participant", "answer");
    expect((await call(getReq(`/api/polls/${pollId}`, alice.cookie))).status).toBe(404);
    await db().prepare("UPDATE polls SET status = 'open' WHERE id = ?").bind(pollId).run();
    await db().prepare("DELETE FROM participants WHERE poll_id = ? AND user_id = ?").bind(pollId, ALICE).run();
    const res = await call(getReq(`/api/polls/${pollId}`, alice.cookie));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("not_participant");
  });

  it("ログアウトするとセッションを消す", async () => {
    const { pollId, auth, req } = await organizer();
    const res = await req("DELETE", "/session");
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call(getReq(`/api/polls/${pollId}`, auth.cookie))).status).toBe(401);
  });
});

describe("公開", () => {
  it("タイトル・候補・参加者がそろっていなければ公開できない", async () => {
    const t = await organizer({ status: "draft", messageId: null });
    await db().prepare("UPDATE polls SET title = NULL WHERE id = ?").bind(t.pollId).run();
    expect((await errorOf(await t.req("POST", "/publish"))).code).toBe("no_title");
    await db().prepare("UPDATE polls SET title = 't' WHERE id = ?").bind(t.pollId).run();
    await db().prepare("DELETE FROM participants WHERE poll_id = ?").bind(t.pollId).run();
    expect((await errorOf(await t.req("POST", "/publish"))).code).toBe("no_participants");
    await db().prepare("INSERT INTO participants (poll_id, user_id, display_name) VALUES (?, ?, 'a')").bind(t.pollId, ALICE).run();
    await db().prepare("DELETE FROM slots WHERE poll_id = ?").bind(t.pollId).run();
    expect((await errorOf(await t.req("POST", "/publish"))).code).toBe("no_slots");
    // 失敗しても投稿の権利は手放す
    expect((await pollRow(t.pollId))!.publishing_at).toBeNull();
  });

  it("締切がなければ 7 日後にし、削除時刻を締切から 6 か月後にする", async () => {
    const t = await organizer({ status: "draft", messageId: null, deadlineAt: null }, (c) => (c.method === "POST" ? { id: "900000000000000001" } : {}));
    const before = nowSec();
    const res = await t.req("POST", "/publish");
    expect(await res.json()).toEqual({ ok: true, redirect: `/p/${t.pollId}/done?kind=published` });
    const row = (await pollRow(t.pollId))!;
    expect(row.status).toBe("open");
    expect(row.message_id).toBe("900000000000000001");
    expect(row.deadline_at as number).toBeGreaterThanOrEqual(Math.floor((before + 7 * DAY) / 60) * 60);
    expect(row.deadline_at as number).toBeLessThanOrEqual(nowSec() + 7 * DAY);
    expect(row.purge_after).toBe((row.deadline_at as number) + RETENTION);
    expect(row.last_synced_at as number).toBeGreaterThanOrEqual(before);
    expect(row.publishing_at).toBeNull();
    const posted = t.calls.filter((c) => c.method === "POST");
    expect(posted).toHaveLength(2);
    expect(JSON.stringify(posted[0]!.body)).toContain("締切");
  });

  it("過去の締切は 7 日後に置き換え、未来の締切はそのまま使う", async () => {
    const future = nowSec() + 3 * DAY;
    const t = await organizer({ status: "draft", messageId: null, deadlineAt: future }, () => ({ id: "900000000000000002" }));
    await t.req("POST", "/publish");
    expect((await pollRow(t.pollId))!.deadline_at).toBe(future);
    const past = await organizer({ status: "draft", messageId: null, deadlineAt: nowSec() - 60 }, () => ({ id: "900000000000000003" }));
    await past.req("POST", "/publish");
    expect((await pollRow(past.pollId))!.deadline_at as number).toBeGreaterThan(nowSec() + 6 * DAY);
  });

  it("公開済みなら 409。チャンネルに投稿できなければ 502、ほかの失敗は 500", async () => {
    const t = await organizer();
    expect((await errorOf(await t.req("POST", "/publish"))).code).toBe("published");
    for (const [status, code] of [[403, 502], [404, 502], [500, 500]] as const) {
      const d = await organizer({ status: "draft", messageId: null }, () => new Response("{}", { status }));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await d.req("POST", "/publish");
      expect(res.status, String(status)).toBe(code);
      if (code === 502) expect((await errorOf(res)).code).toBe("discord_forbidden");
      expect((await pollRow(d.pollId))!.status).toBe("draft");
      expect((await pollRow(d.pollId))!.publishing_at).toBeNull();
    }
  });

  it("投稿の処理中（60 秒以内）なら 409。古い取りかけは取り直せる", async () => {
    const t = await organizer({ status: "draft", messageId: null }, () => ({ id: "900000000000000004" }));
    await db().prepare("UPDATE polls SET publishing_at = ? WHERE id = ?").bind(nowSec() - 30, t.pollId).run();
    expect((await errorOf(await t.req("POST", "/publish"))).code).toBe("publishing");
    await db().prepare("UPDATE polls SET publishing_at = ? WHERE id = ?").bind(nowSec() - 61, t.pollId).run();
    expect((await t.req("POST", "/publish")).status).toBe(200);
  });
});

describe("回答", () => {
  // 募集メッセージがあると、保存のあとの後追いの更新で最大 20 秒待つので、メッセージなしで試す
  async function participant(opts: Parameters<typeof seedPoll>[0] = {}) {
    const t = await organizer({ messageId: null, ...opts });
    const alice = await login(t.pollId, ALICE, "participant", "answer");
    const put = (body: unknown) => call(jsonReq("PUT", `/api/polls/${t.pollId}/answers/me`, body, alice));
    const answers = async () => (await db().prepare("SELECT slot_id, choice_id, prev_choice_id FROM answers WHERE poll_id = ? AND user_id = ? ORDER BY slot_id").bind(t.pollId, ALICE).all()).results;
    const me = () => db().prepare("SELECT comment, answered_at FROM participants WHERE poll_id = ? AND user_id = ?").bind(t.pollId, ALICE).first<{ comment: string | null; answered_at: number | null }>();
    return { ...t, alice, put, answers, me };
  }

  it("下書きには 403。回答の検証", async () => {
    const t = await participant();
    await db().prepare("UPDATE polls SET status = 'draft' WHERE id = ?").bind(t.pollId).run();
    expect((await errorOf(await t.put({ choicesVersion: 1, answers: [], comment: null }))).code).toBe("draft");
    await db().prepare("UPDATE polls SET status = 'cancelled' WHERE id = ?").bind(t.pollId).run();
    expect((await t.put({ choicesVersion: 1, answers: [], comment: null })).status).toBe(404);
    await db().prepare("UPDATE polls SET status = 'open' WHERE id = ?").bind(t.pollId).run();
    const [s0, s1] = t.slotIds as [string, string];
    const [c0] = t.choiceIds as [string];
    expect((await errorOf(await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: "A".repeat(22) }], comment: null }))).message).toContain("候補または選択肢が見つかりません");
    expect((await errorOf(await t.put({ choicesVersion: 1, answers: [{ slotId: "A".repeat(22), choiceId: c0 }], comment: null }))).message).toContain("候補または選択肢が見つかりません");
    expect((await errorOf(await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: c0 }, { slotId: s0, choiceId: c0 }], comment: null }))).message).toBe("同じ候補への回答が重複しています。");
    expect((await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: c0 }, { slotId: s1, choiceId: c0 }], comment: null })).status).toBe(200);
  });

  it("参加者でなくなったら 403", async () => {
    const t = await participant();
    // セッションは残したまま、参加者だけを外す
    await db().prepare("DELETE FROM participants WHERE poll_id = ? AND user_id = ?").bind(t.pollId, ALICE).run();
    expect((await errorOf(await t.put({ choicesVersion: 1, answers: [], comment: null }))).code).toBe("not_participant");
  });

  it("送らなかった候補の回答は消し、全部消したら未回答に戻す。ひとことは空なら null", async () => {
    const t = await participant();
    const [s0, s1] = t.slotIds as [string, string];
    const [c0, c1] = t.choiceIds as [string, string];
    await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: c0 }, { slotId: s1, choiceId: c1 }], comment: " よろしく " });
    expect(await t.me()).toMatchObject({ comment: "よろしく" });
    expect((await t.me())!.answered_at).not.toBeNull();
    await t.put({ choicesVersion: 1, answers: [{ slotId: s1, choiceId: c1 }], comment: "" });
    expect((await t.answers()).map((a) => a.slot_id)).toEqual([s1]);
    expect((await t.me())!.comment).toBeNull();
    await t.put({ choicesVersion: 1, answers: [], comment: null });
    expect(await t.answers()).toEqual([]);
    expect((await t.me())!.answered_at).toBeNull();
  });

  it("同じ回答を送り直しても更新時刻を変えない", async () => {
    const t = await participant();
    const [s0] = t.slotIds as [string];
    const [c0] = t.choiceIds as [string];
    await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: c0 }], comment: null });
    await db().prepare("UPDATE answers SET updated_at = 5 WHERE poll_id = ?").bind(t.pollId).run();
    await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: c0 }], comment: null });
    const r = await db().prepare("SELECT updated_at FROM answers WHERE poll_id = ?").bind(t.pollId).first<{ updated_at: number }>();
    expect(r!.updated_at).toBe(5);
  });

  it("確定した候補は確定時点の回答を残し、元に戻したら消す。確定していない候補は記録しない", async () => {
    const t = await participant({ status: "fixed" });
    const [s0, s1] = t.slotIds as [string, string];
    const [c0, c1] = t.choiceIds as [string, string];
    await db().prepare("UPDATE slots SET fixed_at = 1 WHERE id = ?").bind(s0).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 1)").bind(t.pollId, s0, ALICE, c0).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 1)").bind(t.pollId, s1, ALICE, c0).run();
    await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: c1 }, { slotId: s1, choiceId: c1 }], comment: null });
    expect(await t.answers()).toEqual(
      [
        { slot_id: s0, choice_id: c1, prev_choice_id: c0 },
        { slot_id: s1, choice_id: c1, prev_choice_id: null },
      ].sort((a, b) => (a.slot_id < b.slot_id ? -1 : 1)),
    );
    // もう一度変えても、確定時点の回答を残す
    await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: t.choiceIds[2]! }], comment: null });
    expect((await t.answers()).find((a) => a.slot_id === s0)).toEqual({ slot_id: s0, choice_id: t.choiceIds[2], prev_choice_id: c0 });
    await t.put({ choicesVersion: 1, answers: [{ slotId: s0, choiceId: c0 }], comment: null });
    expect((await t.answers()).find((a) => a.slot_id === s0)).toEqual({ slot_id: s0, choice_id: c0, prev_choice_id: null });
    // 確定後は募集メッセージを更新しない
    expect(t.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("保存は 10 分に 30 回まで", async () => {
    freezeMidWindow();
    const t = await participant();
    await db().prepare("DELETE FROM rate_limits WHERE key LIKE 'answer:%'").run();
    for (let i = 0; i < 30; i++) expect((await t.put({ choicesVersion: 1, answers: [], comment: null })).status).toBe(200);
    expect((await errorOf(await t.put({ choicesVersion: 1, answers: [], comment: null }))).code).toBe("rate_limited");
  });
});

describe("確定と取り消し", () => {
  const voice = (channelId: string | null = "700000000000000001") => ({ type: "voice", channelId, location: null });

  it("公開前は確定できない。知らない候補は 400", async () => {
    const d = await organizer({ status: "draft", messageId: null });
    expect((await errorOf(await d.req("POST", "/fix", { slotId: d.slotIds[0], event: null }))).code).toBe("not_published");
    const t = await organizer();
    expect((await errorOf(await t.req("POST", "/fix", { slotId: "A".repeat(22), event: null }))).code).toBe("invalid");
  });

  it("イベントの内容: ボイスチャンネル・外部の場所、終了がなければ 1 時間、終日なら 1 日", async () => {
    const t = await organizer({}, (c) => (c.method === "POST" && c.path.endsWith("/scheduled-events") ? { id: `ev-${c.path.length}` } : {}));
    const start = nowSec() + 5 * DAY;
    await db().prepare("UPDATE polls SET description = ? WHERE id = ?").bind("説".repeat(1000), t.pollId).run();
    await db().prepare("UPDATE slots SET start_at = ?, end_at = NULL, all_day = 0 WHERE id = ?").bind(start, t.slotIds[0]).run();
    await db().prepare("UPDATE slots SET start_at = ?, end_at = NULL, all_day = 1 WHERE id = ?").bind(start + DAY, t.slotIds[1]).run();
    const r1 = await t.req("POST", "/fix", { slotId: t.slotIds[0], event: voice() });
    expect(await r1.json()).toEqual({ ok: true, warnings: [] });
    await t.req("POST", "/fix", { slotId: t.slotIds[1], event: { type: "external", channelId: null, location: null } });
    const evs = t.calls.filter((c) => c.method === "POST" && c.path === `/guilds/${GUILD}/scheduled-events`).map((c) => c.body as Record<string, any>);
    expect(evs[0]).toEqual({
      name: "定例会",
      description: "説".repeat(1000),
      privacy_level: 2,
      scheduled_start_time: new Date(start * 1000).toISOString(),
      scheduled_end_time: new Date((start + 3600) * 1000).toISOString(),
      entity_type: 2,
      channel_id: "700000000000000001",
    });
    expect(evs[1]).toMatchObject({ entity_type: 3, channel_id: null, entity_metadata: { location: "Discord" }, scheduled_end_time: new Date((start + 2 * DAY) * 1000).toISOString() });
    expect((await slotRow(t.slotIds[0]))!.discord_event_id).toBeTruthy();
    expect((await pollRow(t.pollId))!.status).toBe("fixed");
  });

  it("イベントを登録できないときの警告", async () => {
    const start = nowSec() + 5 * DAY;
    const cases: [unknown, number | null, string][] = [
      [voice(null), null, "ボイスチャンネルが選ばれていないため"],
      [voice(), 403, "「イベントの作成」権限がないため"],
      [voice(), 500, "Discord イベントを登録できませんでした。"],
    ];
    for (const [event, status, warning] of cases) {
      const t = await organizer({}, (c) => (c.path.endsWith("/scheduled-events") && status ? new Response("{}", { status }) : { id: "e" }));
      await db().prepare("UPDATE slots SET start_at = ? WHERE id = ?").bind(start, t.slotIds[0]).run();
      const body = (await (await t.req("POST", "/fix", { slotId: t.slotIds[0], event })).json()) as { warnings: string[] };
      expect(body.warnings.join(), warning).toContain(warning);
    }
    // 開始が 1 分以内なら登録しない
    const soon = await organizer();
    await db().prepare("UPDATE slots SET start_at = ? WHERE id = ?").bind(nowSec() + 30, soon.slotIds[0]).run();
    const body = (await (await soon.req("POST", "/fix", { slotId: soon.slotIds[0], event: voice() })).json()) as { warnings: string[] };
    expect(body.warnings).toEqual(["開始日時が過ぎているため、Discord イベントは登録しませんでした。"]);
  });

  it("募集メッセージを更新できなくても確定する（警告は出さない: 更新の失敗は後で取り戻す）", async () => {
    const t = await organizer({}, (c) => (c.method === "PATCH" ? new Response("{}", { status: 500 }) : {}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await t.req("POST", "/fix", { slotId: t.slotIds[0], event: null });
    expect(res.status).toBe(200);
    expect((await slotRow(t.slotIds[0]))!.fixed_at).not.toBeNull();
  });

  it("取り消し: 知らない候補は 404、確定していない候補は 409。イベントを消せなければ警告", async () => {
    const t = await organizer({ status: "fixed" }, (c) => (c.method === "DELETE" ? new Response("{}", { status: 500 }) : {}));
    expect((await errorOf(await t.req("DELETE", `/fix/${"A".repeat(22)}`))).code).toBe("not_found");
    expect((await errorOf(await t.req("DELETE", `/fix/${t.slotIds[1]}`))).code).toBe("not_fixed");
    await db().prepare("UPDATE slots SET fixed_at = 1, discord_event_id = 'ev', day_reminded_at = 9 WHERE id = ?").bind(t.slotIds[0]).run();
    const body = (await (await t.req("DELETE", `/fix/${t.slotIds[0]}`)).json()) as { warnings: string[] };
    expect(body.warnings).toEqual(["登録済みの Discord イベントを削除できませんでした。Discord で削除してください。"]);
    expect(await slotRow(t.slotIds[0])).toMatchObject({ fixed_at: null, discord_event_id: null, day_reminded_at: null });
    expect((await pollRow(t.pollId))!.status).toBe("open");
  });

  it("取り消し: イベントがすでに消えていれば警告しない", async () => {
    const t = await organizer({ status: "fixed" }, (c) => (c.method === "DELETE" ? new Response("{}", { status: 404 }) : {}));
    await db().prepare("UPDATE slots SET fixed_at = 1, discord_event_id = 'ev' WHERE id = ?").bind(t.slotIds[0]).run();
    expect(await (await t.req("DELETE", `/fix/${t.slotIds[0]}`)).json()).toEqual({ ok: true, warnings: [] });
    expect((await slotRow(t.slotIds[0]))!.discord_event_id).toBeNull();
  });

  it("候補の日時を変えたときのイベントの更新: 消えていれば記録を外し、失敗すれば警告。開始間近なら変えない", async () => {
    const start = nowSec() + 5 * DAY;
    const run = async (status: number | null, newStart: number) => {
      const t = await organizer({ status: "fixed" }, (c) => (c.path.includes("scheduled-events") && status ? new Response("{}", { status }) : {}));
      await db().prepare("UPDATE slots SET fixed_at = 1, discord_event_id = 'ev', start_at = ?, end_at = NULL WHERE id = ?").bind(start, t.slotIds[0]).run();
      const rows = (await db().prepare("SELECT id, start_at, end_at FROM slots WHERE poll_id = ? ORDER BY position").bind(t.pollId).all<{ id: string; start_at: number; end_at: number | null }>()).results;
      const slots = rows.map((r) => ({ id: r.id, startAt: r.id === t.slotIds[0] ? newStart : r.start_at, endAt: r.id === t.slotIds[0] ? null : r.end_at, allDay: false }));
      const body = (await (await t.req("PUT", "/slots", { slots })).json()) as { warnings: string[] };
      const patch = t.calls.find((c) => c.method === "PATCH" && c.path.includes("scheduled-events"));
      return { body, patch, slot: await slotRow(t.slotIds[0]) };
    };
    const ok = await run(null, start + 600);
    expect(ok.body.warnings).toEqual([]);
    expect(ok.patch!.body).toEqual({ scheduled_start_time: new Date((start + 600) * 1000).toISOString(), scheduled_end_time: new Date((start + 4200) * 1000).toISOString() });
    const gone = await run(404, start + 600);
    expect(gone.body.warnings).toEqual([]);
    expect(gone.slot!.discord_event_id).toBeNull();
    const failed = await run(500, start + 600);
    expect(failed.body.warnings).toEqual(["Discord イベントの日時を変更できませんでした。Discord で変更してください。"]);
    const soon = await run(null, nowSec() + 30);
    expect(soon.body.warnings).toEqual(["確定した候補の開始日時が過ぎているため、Discord イベントの日時は変更しませんでした。"]);
    expect(soon.patch).toBeUndefined();
  });

  it("確定し直したとき、登録済みのイベントが消えていれば作り直す", async () => {
    const start = nowSec() + 5 * DAY;
    const t = await organizer({ status: "fixed" }, (c) => (c.method === "PATCH" && c.path.includes("scheduled-events") ? new Response("{}", { status: 404 }) : c.method === "POST" && c.path.endsWith("/scheduled-events") ? { id: "new-ev" } : {}));
    await db().prepare("UPDATE slots SET discord_event_id = 'old-ev', start_at = ? WHERE id = ?").bind(start, t.slotIds[0]).run();
    expect(await (await t.req("POST", "/fix", { slotId: t.slotIds[0], event: voice() })).json()).toEqual({ ok: true, warnings: [] });
    expect((await slotRow(t.slotIds[0]))!.discord_event_id).toBe("new-ev");
  });
});

describe("確定のお知らせ", () => {
  it("公開前は 409。1 時間に 10 回まで", async () => {
    const d = await organizer({ status: "draft", messageId: null });
    expect((await errorOf(await d.req("POST", "/announce", { mention: false }))).code).toBe("not_published");
    const t = await organizer({ status: "fixed" });
    await db().prepare("UPDATE slots SET fixed_at = 1 WHERE id = ?").bind(t.slotIds[0]).run();
    for (let i = 0; i < 10; i++) expect((await t.req("POST", "/announce", { mention: false })).status).toBe(200);
    expect((await errorOf(await t.req("POST", "/announce", { mention: false }))).code).toBe("rate_limited");
  });

  it("確定した日時と取り消した日時を、終日と時刻つきで書き分ける", async () => {
    const t = await organizer({ status: "fixed" });
    const start = nowSec() + 10 * DAY;
    await db().prepare("UPDATE slots SET fixed_at = 1, all_day = 1, start_at = ? WHERE id = ?").bind(start, t.slotIds[0]).run();
    await db().prepare("UPDATE slots SET announced_fixed = 1, start_at = ? WHERE id = ?").bind(start + DAY, t.slotIds[1]).run();
    await t.req("POST", "/announce", { mention: false });
    const msg = t.calls.find((c) => c.method === "POST")!.body as { content: string };
    expect(msg.content).toContain(`確定した日時:\n・<t:${start}:D>（終日）`);
    expect(msg.content).toContain(`確定を取り消した日時:\n・~~<t:${start + DAY}:F>~~`);
    expect(await slotRow(t.slotIds[1])).toMatchObject({ announced_fixed: 0 });
    expect(await slotRow(t.slotIds[0])).toMatchObject({ announced_fixed: 1 });
  });

  it("投稿に失敗したら 502", async () => {
    const t = await organizer({ status: "fixed" }, (c) => (c.method === "POST" ? new Response("{}", { status: 500 }) : {}));
    await db().prepare("UPDATE slots SET fixed_at = 1 WHERE id = ?").bind(t.slotIds[0]).run();
    expect((await errorOf(await t.req("POST", "/announce", { mention: true }))).code).toBe("discord_failed");
  });
});

describe("回答のリマインド", () => {
  it("下書き・確定後はできない。12 時間に 1 回まで", async () => {
    const d = await organizer({ status: "draft", messageId: null });
    expect((await errorOf(await d.req("POST", "/remind"))).code).toBe("draft");
    const t = await organizer();
    const res = await t.req("POST", "/remind");
    expect(await res.json()).toEqual({ ok: true, count: 3 });
    expect((await errorOf(await t.req("POST", "/remind"))).code).toBe("rate_limited");
    await db().prepare("UPDATE polls SET last_reminded_at = ? WHERE id = ?").bind(nowSec() - 12 * 3600 + 60, t.pollId).run();
    expect((await t.req("POST", "/remind")).status).toBe(429);
    await db().prepare("UPDATE polls SET last_reminded_at = ? WHERE id = ?").bind(nowSec() - 12 * 3600 - 1, t.pollId).run();
    expect((await t.req("POST", "/remind")).status).toBe(200);
  });

  it("未回答の人だけをメンションし、締切と募集メッセージのリンクを添える。全員回答済みなら送らない", async () => {
    const t = await organizer();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 1)").bind(t.pollId, t.slotIds[0], ALICE, t.choiceIds[0]).run();
    const deadline = (await pollRow(t.pollId))!.deadline_at as number;
    expect(await (await t.req("POST", "/remind")).json()).toEqual({ ok: true, count: 2 });
    const msg = t.calls.find((c) => c.method === "POST")!.body as { content: string; allowed_mentions: { users: string[] }; components: unknown };
    expect(msg.content.split("\n").slice(0, 2)).toEqual([
      `**定例会** の回答をお願いします（締切 <t:${deadline}:f>）。募集メッセージの［回答する］から入力できます。`,
      `https://discord.com/channels/${GUILD}/${CHANNEL}/500000000000000001`,
    ]);
    expect(msg.allowed_mentions.users.sort()).toEqual([ORGANIZER, BOB].sort());

    const all = await organizer({ participants: [ORGANIZER] });
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 1)").bind(all.pollId, all.slotIds[0], ORGANIZER, all.choiceIds[0]).run();
    expect(await (await all.req("POST", "/remind")).json()).toEqual({ ok: true, count: 0 });
    expect(all.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((await pollRow(all.pollId))!.last_reminded_at).toBeNull();
  });

  it("締切・募集メッセージがなければ、その部分を書かない", async () => {
    const t = await organizer({ deadlineAt: null, messageId: null });
    await t.req("POST", "/remind");
    const msg = t.calls.find((c) => c.method === "POST")!.body as { content: string };
    expect(msg.content.split("\n")[0]).toBe("**定例会** の回答をお願いします。募集メッセージの［回答する］から入力できます。");
    expect(msg.content).not.toContain("https://");
  });
});

describe("手動更新・投稿し直し", () => {
  it("手動更新: 募集メッセージがなければ 409、更新できなければ 502", async () => {
    const none = await organizer({ messageId: null });
    expect((await errorOf(await none.req("POST", "/sync-message"))).code).toBe("no_message");
    const t = await organizer({}, (c) => (c.method === "PATCH" ? new Response("{}", { status: 500 }) : {}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await errorOf(await t.req("POST", "/sync-message"))).code).toBe("sync_failed");
    const ok = await organizer();
    const body = (await (await ok.req("POST", "/sync-message")).json()) as { ok: boolean; lastSyncedAt: number };
    expect(body.ok).toBe(true);
    expect(body.lastSyncedAt).toBeGreaterThanOrEqual(nowSec() - 1);
  });

  it("投稿し直し: 公開前は 409。新しいメッセージを記録し、古いメッセージを消す", async () => {
    const d = await organizer({ status: "draft", messageId: null });
    expect((await errorOf(await d.req("POST", "/repost"))).code).toBe("not_published");
    const t = await organizer({}, (c) => (c.method === "POST" ? { id: "900000000000000077" } : {}));
    expect(await (await t.req("POST", "/repost")).json()).toEqual({ ok: true });
    expect((await pollRow(t.pollId))!.message_id).toBe("900000000000000077");
    expect(t.calls.some((c) => c.method === "DELETE" && c.path === `/channels/${CHANNEL}/messages/500000000000000001`)).toBe(true);
    expect((await errorOf(await t.req("POST", "/repost"))).code).toBe("rate_limited");
  });

  it("投稿し直し: 古いメッセージがなければ何も消さない", async () => {
    const t = await organizer({ messageId: null }, (c) => (c.method === "POST" ? { id: "900000000000000078" } : {}));
    await t.req("POST", "/repost");
    expect(t.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("削除", () => {
  it("募集メッセージを「削除されました」にし、イベントを消す。消えていたイベントは警告しない", async () => {
    const t = await organizer({}, (c) => (c.method === "DELETE" && c.path.endsWith("/gone") ? new Response("{}", { status: 404 }) : {}));
    await db().prepare("UPDATE slots SET discord_event_id = 'gone' WHERE id = ?").bind(t.slotIds[0]).run();
    const res = await t.req("DELETE", "");
    expect(await res.json()).toEqual({ ok: true, warnings: [] });
    expect(res.headers.get("Set-Cookie")).toBe(`__Host-s_${t.pollId}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    const patch = t.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe(`/channels/${CHANNEL}/messages/500000000000000001`);
    expect(JSON.stringify(patch.body)).toContain("この調整は主催者によって削除されました。");
    expect(await pollRow(t.pollId)).toBeNull();
  });

  it("イベントを消せなければ警告する。募集メッセージがなければ書き換えない", async () => {
    const t = await organizer({ messageId: null }, (c) => (c.method === "DELETE" ? new Response("{}", { status: 500 }) : {}));
    await db().prepare("UPDATE slots SET discord_event_id = 'x' WHERE id = ?").bind(t.slotIds[0]).run();
    expect(await (await t.req("DELETE", "")).json()).toEqual({ ok: true, warnings: ["Discord イベントを削除できませんでした。Discord で削除してください。"] });
    expect(t.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("主催者の調整一覧", () => {
  async function listLogin(guildId = GUILD, userId = ORGANIZER) {
    const url = await issueListLink(db(), ORIGIN, guildId, userId);
    const res = await call(jsonReq("POST", "/api/session", { token: tokenFromUrl(url) }));
    const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    const data = (await (await call(getReq(`/api/guilds/${guildId}/polls`, cookie))).json()) as { csrfToken: string; polls: Record<string, any>[]; now: number };
    return { cookie, csrf: data.csrfToken, data };
  }

  it("サーバーの ID の形式が違えば 404、セッションがなければ 401", async () => {
    mockDiscord();
    expect((await call(getReq("/api/guilds/abc/polls"))).status).toBe(404);
    expect((await call(getReq("/api/guilds/1234567890123456/polls"))).status).toBe(404);
    const res = await call(getReq(`/api/guilds/${GUILD}/polls`));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("list_session_expired");
  });

  it("確定した日時を日時順に、状態・リンクとともに返す", async () => {
    mockDiscord();
    const p = await seedPoll({ status: "fixed" });
    await db().prepare("UPDATE slots SET fixed_at = 1, all_day = 1 WHERE id = ?").bind(p.slotIds[2]).run();
    await db().prepare("UPDATE slots SET fixed_at = 1 WHERE id = ?").bind(p.slotIds[0]).run();
    const closed = await seedPoll({ deadlineAt: nowSec() - 60, messageId: null });
    const { data } = await listLogin();
    const fixed = data.polls.find((x) => x.id === p.pollId)!;
    expect(fixed.status).toBe("fixed");
    expect(fixed.fixed.map((f: { allDay: boolean }) => f.allDay)).toEqual([false, true]);
    expect(fixed.fixed[0].startAt).toBeLessThan(fixed.fixed[1].startAt);
    expect(fixed.messageUrl).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/500000000000000001`);
    expect(fixed.timezone).toBe("Asia/Tokyo");
    const c = data.polls.find((x) => x.id === closed.pollId)!;
    expect(c).toMatchObject({ status: "closed", messageUrl: null, fixed: [] });
  });

  it("CSRF トークンが違えば 403。開くときは集計画面か編集画面へ", async () => {
    mockDiscord();
    const p = await seedPoll();
    const { cookie, csrf } = await listLogin();
    const open = (to: string, c?: string) => call(jsonReq("POST", `/api/guilds/${GUILD}/polls/${p.pollId}/open`, { to }, { cookie, csrf: c }));
    expect((await errorOf(await open("summary", `${csrf.slice(1)}A`))).code).toBe("bad_csrf");
    expect(await (await open("summary", csrf)).json()).toEqual({ redirect: `/p/${p.pollId}` });
    await db().prepare("UPDATE polls SET status = 'cancelled' WHERE id = ?").bind(p.pollId).run();
    expect((await open("edit", csrf)).status).toBe(404);
  });

  it("一覧から削除できる。ほかのサーバーの調整は消せない", async () => {
    const calls = mockDiscord();
    const p = await seedPoll();
    const other = await seedPoll();
    await db().prepare("UPDATE polls SET guild_id = '200000000000000888' WHERE id = ?").bind(other.pollId).run();
    const { cookie, csrf } = await listLogin();
    const del = (id: string) => call(jsonReq("DELETE", `/api/guilds/${GUILD}/polls/${id}`, undefined, { cookie, csrf }));
    expect((await del(other.pollId)).status).toBe(404);
    expect(await (await del(p.pollId)).json()).toEqual({ ok: true, warnings: [] });
    expect(await pollRow(p.pollId)).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });
});
