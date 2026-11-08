import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { issueLink } from "../src/auth";
import { ALICE, BOB, call, getReq, jsonReq, login, mockDiscord, ORGANIZER, ORIGIN, OUTSIDER, seedPoll, tokenFromUrl } from "./helpers";

const db = () => (env as unknown as Env).DB;

beforeEach(() => {
  mockDiscord();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("セッション（入力リンクの交換）", () => {
  it("正しいトークンで Cookie を発行し、用途に応じた画面を返す", async () => {
    const { pollId } = await seedPoll();
    const url = await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer");
    expect(url).toMatch(/\/l#t=[A-Za-z0-9_-]{43}$/);
    const res = await call(jsonReq("POST", "/api/session", { token: tokenFromUrl(url) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: `/p/${pollId}/answer` });
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`__Host-s_${pollId}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("同じトークンは 2 回使えない", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(200);
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(401);
  });

  it("期限切れのトークンは使えない", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    await db().prepare("UPDATE link_tokens SET expires_at = 1").run();
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(401);
  });

  it("DB にはトークンのハッシュだけを保存する", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    const rows = await db().prepare("SELECT token_hash FROM link_tokens").all<{ token_hash: string }>();
    expect(rows.results.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.results.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it("Origin が違う POST は拒否する（CSRF 対策）", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    expect((await call(jsonReq("POST", "/api/session", { token }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(jsonReq("POST", "/api/session", { token }, { origin: null }))).status).toBe(403);
    expect((await call(jsonReq("POST", "/api/session", { token }, { contentType: "text/plain" }))).status).toBe(415);
  });
});

describe("外部の人から見えないこと（§6.6）", () => {
  it("セッションがなければ何も返さない", async () => {
    const { pollId } = await seedPoll();
    const res = await call(getReq(`/api/polls/${pollId}`));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("定例会");
  });

  it("別の調整のセッションでは見られない", async () => {
    const a = await seedPoll();
    const b = await seedPoll();
    const { cookie } = await login(a.pollId, ALICE, "participant");
    const forged = cookie.replace(a.pollId, b.pollId);
    expect((await call(getReq(`/api/polls/${b.pollId}`, forged))).status).toBe(401);
  });

  it("参加者から外された人はセッションが消える", async () => {
    const { pollId } = await seedPoll();
    const alice = await login(pollId, ALICE, "participant");
    const org = await login(pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("PUT", `/api/polls/${pollId}/participants`, { add: [], remove: [ALICE] }, org));
    expect(res.status).toBe(200);
    expect((await call(getReq(`/api/polls/${pollId}`, alice.cookie))).status).toBe(401);
  });

  it("参加者でない人のトークンはセッションに交換できない", async () => {
    const { pollId } = await seedPoll();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, OUTSIDER, "participant", "answer"));
    expect((await call(jsonReq("POST", "/api/session", { token }))).status).toBe(403);
  });

  it("下書きは参加者には見せない", async () => {
    const { pollId } = await seedPoll({ status: "draft" });
    await db().prepare("INSERT INTO sessions (sid_hash, poll_id, user_id, role, csrf_token, expires_at, created_at) VALUES ('x', ?, ?, 'participant', 'c', 9999999999, 0)").bind(pollId, ALICE).run();
    const { cookie } = await login(pollId, ORGANIZER, "organizer", "edit");
    expect((await call(getReq(`/api/polls/${pollId}`, cookie))).status).toBe(200);
  });

  it("API の応答にセキュリティヘッダーが付く", async () => {
    const { pollId } = await seedPoll();
    const res = await call(getReq(`/api/polls/${pollId}`));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

describe("回答（§4.2）", () => {
  it("CSRF トークンがなければ保存できない", async () => {
    const s = await seedPoll();
    const { cookie } = await login(s.pollId, ALICE, "participant");
    const body = { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null };
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, body, { cookie }))).status).toBe(403);
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, body, { cookie, csrf: "wrong" }))).status).toBe(403);
  });

  it("自分の回答を保存でき、参加者全員がその回答を見られる", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const res = await call(
      jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: "21時からなら" }, alice),
    );
    expect(res.status).toBe(200);
    const bob = await login(s.pollId, BOB, "participant");
    const data = (await (await call(getReq(`/api/polls/${s.pollId}`, bob.cookie))).json()) as { answers: { userId: string }[]; participants: { userId: string; comment: string }[] };
    expect(data.answers.some((a) => a.userId === ALICE)).toBe(true);
    expect(data.participants.find((p) => p.userId === ALICE)!.comment).toBe("21時からなら");
  });

  it("他の調整の候補や選択肢は指定できない", async () => {
    const a = await seedPoll();
    const b = await seedPoll();
    const alice = await login(a.pollId, ALICE, "participant");
    const res = await call(jsonReq("PUT", `/api/polls/${a.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: b.slotIds[0], choiceId: a.choiceIds[0] }], comment: null }, alice));
    expect(res.status).toBe(400);
  });

  it("未知のキーは拒否する", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [], comment: null, userId: BOB }, alice));
    expect(res.status).toBe(400);
  });

  it("締切後も確定後も回答を変更でき、確定後の変更は記録される", async () => {
    const s = await seedPoll({ deadlineAt: 1000 });
    const alice = await login(s.pollId, ALICE, "participant");
    const put = (choiceIdx: number) =>
      call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[choiceIdx] }], comment: null }, alice));
    expect((await put(0)).status).toBe(200); // 締切後
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const fix = await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], mention: false, event: null }, org));
    expect(fix.status).toBe(200);
    expect((await put(2)).status).toBe(200); // 確定後に ○ → ×
    const row = await db().prepare("SELECT choice_id, prev_choice_id FROM answers WHERE poll_id = ? AND user_id = ?").bind(s.pollId, ALICE).first<{ choice_id: string; prev_choice_id: string }>();
    expect(row).toEqual({ choice_id: s.choiceIds[2], prev_choice_id: s.choiceIds[0] });
    expect((await put(0)).status).toBe(200); // 元に戻したら記録は消える
    const row2 = await db().prepare("SELECT prev_choice_id FROM answers WHERE poll_id = ? AND user_id = ?").bind(s.pollId, ALICE).first<{ prev_choice_id: string | null }>();
    expect(row2!.prev_choice_id).toBeNull();
  });

  it("選択肢の版が古いと 409", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 99, answers: [], comment: null }, alice));
    expect(res.status).toBe(409);
  });
});

describe("主催者だけの操作", () => {
  it("参加者は編集・確定・削除・リマインド・手動更新ができない", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    expect((await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { title: "乗っ取り" }, alice))).status).toBe(403);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], mention: false, event: null }, alice))).status).toBe(403);
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}`, {}, alice))).status).toBe(403);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/remind`, {}, alice))).status).toBe(403);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/sync-message`, {}, alice))).status).toBe(403);
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/participants`, { add: [], remove: [BOB] }, alice))).status).toBe(403);
  });

  it("選択肢を変更でき、回答がある選択肢は移し先なしでは消せない", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[1] }], comment: null }, alice));
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const twoChoices = [
      { id: s.choiceIds[0], symbol: "○", label: "参加", kind: "ok", score: 2, color: "green" },
      { id: s.choiceIds[2], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ];
    const noReassign = await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices: twoChoices, reassign: [] }, org));
    expect(noReassign.status).toBe(400);
    const ok = await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices: twoChoices, reassign: [{ from: s.choiceIds[1], to: s.choiceIds[2] }] }, org));
    expect(ok.status).toBe(200);
    const row = await db().prepare("SELECT choice_id FROM answers WHERE poll_id = ?").bind(s.pollId).first<{ choice_id: string }>();
    expect(row!.choice_id).toBe(s.choiceIds[2]);
  });

  it("選択肢の記号にメンション記法は使えない", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(
      jsonReq(
        "PUT",
        `/api/polls/${s.pollId}/choices`,
        {
          choicesVersion: 1,
          choices: [
            { id: null, symbol: "<@1>", label: "参加", kind: "ok", score: 2, color: "green" },
            { id: null, symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
          ],
          reassign: [],
        },
        org,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("公開すると募集メッセージを投稿し、メンションを無効にしている", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000001" } : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org));
    expect(res.status).toBe(200);
    const post = calls.find((c) => c.method === "POST" && c.path === `/channels/300000000000000001/messages`)!;
    expect((post.body as { allowed_mentions: { parse: string[] } }).allowed_mentions.parse).toEqual([]);
    const poll = await db().prepare("SELECT status, message_id, deadline_at FROM polls WHERE id = ?").bind(s.pollId).first<{ status: string; message_id: string; deadline_at: number }>();
    expect(poll!.status).toBe("open");
    expect(poll!.message_id).toBe("600000000000000001");
    expect(poll!.deadline_at).toBeGreaterThan(Date.now() / 1000 + 6 * 86400);
  });

  it("手動更新は 1 分に 1 回まで", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/sync-message`, {}, org))).status).toBe(200);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/sync-message`, {}, org))).status).toBe(429);
  });

  it("削除するとデータが消え、セッションも使えなくなる", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}`, {}, org))).status).toBe(200);
    expect((await call(getReq(`/api/polls/${s.pollId}`, alice.cookie))).status).toBe(401);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM answers WHERE poll_id = ?").bind(s.pollId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("同時に公開しても、募集メッセージは 1 件だけ投稿する", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000002" } : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const [a, b] = await Promise.all([
      call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org)),
      call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).length).toBe(1);
  });

  it("投稿に失敗したら、もう一度公開できる", async () => {
    mockDiscord((c) => (c.method === "POST" ? new Response("{}", { status: 403 }) : {}));
    const s = await seedPoll({ status: "draft", messageId: null, deadlineAt: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org))).status).toBe(502);
    vi.restoreAllMocks();
    mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000003" } : {}));
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/publish`, {}, org))).status).toBe(200);
  });

  it("イベントを外して確定し直すと、登録済みの Discord イベントを削除する", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: "700000000000000009" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], mention: false, event: { type: "external", channelId: null, location: "Discord" } }, org));
    const res = await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[1], mention: false, event: null }, org));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/scheduled-events/700000000000000009"))).toBe(true);
    const row = await db().prepare("SELECT discord_event_id FROM polls WHERE id = ?").bind(s.pollId).first<{ discord_event_id: string | null }>();
    expect(row!.discord_event_id).toBeNull();
  });
});

describe("確定後の回答の記録", () => {
  it("確定時点で未回答だった候補に答えると「未回答から変更」として記録し、送らなかった候補の回答は消さない", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null }, alice));
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[1], mention: false, event: null }, org));
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[1], choiceId: s.choiceIds[0] }], comment: null }, alice));
    expect(res.status).toBe(200);
    const rows = await db().prepare("SELECT slot_id, prev_choice_id FROM answers WHERE poll_id = ? AND user_id = ? ORDER BY slot_id").bind(s.pollId, ALICE).all<{ slot_id: string; prev_choice_id: string | null }>();
    const bySlot = new Map(rows.results.map((r) => [r.slot_id, r.prev_choice_id]));
    expect(bySlot.get(s.slotIds[1]!)).toBe("");
    expect(bySlot.has(s.slotIds[0]!)).toBe(true);
  });
});

describe("募集メッセージの更新", () => {
  it("募集メッセージがないときは、最終更新時刻を書き換えない", async () => {
    const { syncNow } = await import("../src/polls/sync");
    const s = await seedPoll({ messageId: null });
    await db().prepare("UPDATE polls SET last_synced_at = 123 WHERE id = ?").bind(s.pollId).run();
    expect(await syncNow(env as unknown as Env, s.pollId)).toBe(false);
    const row = await db().prepare("SELECT last_synced_at FROM polls WHERE id = ?").bind(s.pollId).first<{ last_synced_at: number }>();
    expect(row!.last_synced_at).toBe(123);
  });
});

describe("2 回目のレビューの修正", () => {
  it("締切を過ぎて日がたった調整でも、締切を変えなければ保存できる", async () => {
    const s = await seedPoll({ deadlineAt: 1000 });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const same = await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { title: "新しい名前", deadlineAt: 1000 }, org));
    expect(same.status).toBe(200);
    const row = await db().prepare("SELECT title FROM polls WHERE id = ?").bind(s.pollId).first<{ title: string }>();
    expect(row!.title).toBe("新しい名前");
    // 過去の日時に変えるのはこれまでどおり拒否する
    expect((await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { deadlineAt: 2000 }, org))).status).toBe(400);
  });

  it("確定した候補の日時を変えると、Discord イベントの日時も変える", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: "700000000000000010" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], mention: false, event: { type: "external", channelId: null, location: "Discord" } }, org));
    const slots = await db().prepare("SELECT id, start_at, end_at FROM slots WHERE poll_id = ? ORDER BY position").bind(s.pollId).all<{ id: string; start_at: number; end_at: number }>();
    const body = { slots: slots.results.map((x, i) => ({ id: x.id, startAt: i === 0 ? x.start_at + 3600 : x.start_at, endAt: i === 0 ? x.end_at + 3600 : x.end_at, allDay: false })) };
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/slots`, body, org));
    expect(res.status).toBe(200);
    const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/700000000000000010"));
    expect(patch).toBeTruthy();
    expect((patch!.body as { scheduled_start_time: string }).scheduled_start_time).toBe(new Date((slots.results[0]!.start_at + 3600) * 1000).toISOString());
  });

  it("確定後にひとことだけ保存しても、回答が残っていれば回答済みのまま", async () => {
    const s = await seedPoll();
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null }, alice));
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], mention: false, event: null }, org));
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [], comment: "遅れます" }, alice));
    const p = await db().prepare("SELECT answered_at, comment FROM participants WHERE poll_id = ? AND user_id = ?").bind(s.pollId, ALICE).first<{ answered_at: number | null; comment: string }>();
    expect(p!.answered_at).not.toBeNull();
    expect(p!.comment).toBe("遅れます");
  });
});

describe("3 回目のレビューの修正", () => {
  it("締切は分単位で比べる（秒が違うだけなら変えていないとみなす）", async () => {
    const s = await seedPoll({ deadlineAt: 1_000_037 });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("PATCH", `/api/polls/${s.pollId}`, { title: "改名", deadlineAt: 1_000_020 }, org));
    expect(res.status).toBe(200);
  });

  it("候補・選択肢の ID が重複していたら拒否する", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const now = Math.floor(Date.now() / 1000) + 86400;
    const dupSlots = { slots: [{ id: s.slotIds[0], startAt: now, endAt: null, allDay: false }, { id: s.slotIds[0], startAt: now + 3600, endAt: null, allDay: false }] };
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/slots`, dupSlots, org))).status).toBe(400);
    const dupChoices = {
      choicesVersion: 1,
      choices: [
        { id: s.choiceIds[0], symbol: "○", label: "参加", kind: "ok", score: 2, color: "green" },
        { id: s.choiceIds[0], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
      ],
      reassign: [],
    };
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, dupChoices, org))).status).toBe(400);
  });

  it("公開後に選択肢を変えると、回答画面に知らせるための時刻を返す", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const choices = [
      { id: s.choiceIds[0], symbol: "○", label: "参加する", kind: "ok", score: 2, color: "green" },
      { id: s.choiceIds[1], symbol: "△", label: "未定", kind: "maybe", score: 1, color: "yellow" },
      { id: s.choiceIds[2], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ];
    expect((await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices, reassign: [] }, org))).status).toBe(200);
    const alice = await login(s.pollId, ALICE, "participant");
    const data = (await (await call(getReq(`/api/polls/${s.pollId}`, alice.cookie))).json()) as { poll: { choicesChangedAt: number | null } };
    expect(data.poll.choicesChangedAt).not.toBeNull();
  });

  it("調整を削除すると、登録済みの Discord イベントも削除する", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" && c.path.includes("scheduled-events") ? { id: "700000000000000011" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], mention: false, event: { type: "external", channelId: null, location: "Discord" } }, org));
    expect((await call(jsonReq("DELETE", `/api/polls/${s.pollId}`, {}, org))).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/scheduled-events/700000000000000011"))).toBe(true);
  });
});

describe("4 回目のレビューの修正", () => {
  it("募集メッセージが消えていたら、もう一度投稿できる", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000099" } : {}));
    const s = await seedPoll({ messageId: null });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/repost`, {}, org))).status).toBe(200);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).length).toBe(1);
    const row = await db().prepare("SELECT message_id, publishing_at FROM polls WHERE id = ?").bind(s.pollId).first<{ message_id: string; publishing_at: number | null }>();
    expect(row).toEqual({ message_id: "600000000000000099", publishing_at: null });
  });

  it("投稿し直すと、古い募集メッセージは削除する", async () => {
    const calls = mockDiscord((c) => (c.method === "POST" ? { id: "600000000000000098" } : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/repost`, {}, org))).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/messages/500000000000000001"))).toBe(true);
  });

  it("参加者は投稿し直せない", async () => {
    const s = await seedPoll({ messageId: null });
    const alice = await login(s.pollId, ALICE, "participant");
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/repost`, {}, alice))).status).toBe(403);
  });

  it("ロールの一覧の取得にも回数制限がある", async () => {
    mockDiscord((c) => (c.path.endsWith("/roles") ? [] : {}));
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call(getReq(`/api/polls/${s.pollId}/roles`, org.cookie))).status;
    expect(last).toBe(429);
  });

  it("参加者が多くても 1 文でまとめて追加できる", async () => {
    const { insertParticipantsStatement } = await import("../src/db");
    const s = await seedPoll({ participants: [] });
    const people = Array.from({ length: 100 }, (_, i) => ({ userId: `4100000000000${String(i).padStart(5, "0")}`, displayName: `名前${i}` }));
    await insertParticipantsStatement(db(), s.pollId, people).run();
    const n = await db().prepare("SELECT COUNT(*) AS n FROM participants WHERE poll_id = ?").bind(s.pollId).first<{ n: number }>();
    expect(n!.n).toBe(100);
  });
});

describe("5 回目のレビューの修正", () => {
  it("古いメッセージの更新が 404 になっても、投稿し直した新しいメッセージの ID は消さない", async () => {
    const { syncNow } = await import("../src/polls/sync");
    const s = await seedPoll();
    // 更新のリクエストを送った時点では古い ID だったが、その間に投稿し直しで新しい ID に変わった、という状況を作る
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await db().prepare("UPDATE polls SET message_id = '600000000000000777' WHERE id = ?").bind(s.pollId).run();
      return new Response("{}", { status: 404 });
    });
    await db().prepare("UPDATE polls SET last_synced_at = 1 WHERE id = ?").bind(s.pollId).run();
    expect(await syncNow(env as unknown as Env, s.pollId)).toBe(false);
    const row = await db().prepare("SELECT message_id FROM polls WHERE id = ?").bind(s.pollId).first<{ message_id: string | null }>();
    expect(row!.message_id).toBe("600000000000000777");
  });

  it("更新は、権利を取ったあとのデータでメッセージを作る", async () => {
    const { syncNow } = await import("../src/polls/sync");
    const calls = mockDiscord();
    const s = await seedPoll();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(s.pollId, s.slotIds[0], ALICE, s.choiceIds[0], 5).run();
    expect(await syncNow(env as unknown as Env, s.pollId)).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.stringify(patch.body)).toContain("回答: 1/3 名");
  });
});

describe("7 回目のレビューの修正", () => {
  it("確定後はリマインドできない", async () => {
    const s = await seedPoll();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    await call(jsonReq("POST", `/api/polls/${s.pollId}/fix`, { slotId: s.slotIds[0], mention: false, event: null }, org));
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/remind`, {}, org))).status).toBe(409);
  });

  it("選択肢の変更のお知らせは、ひとことだけ保存しても消えず、確認したら消える", async () => {
    // 募集メッセージなし（連続した保存による後追いの更新の待ち時間をテストに持ち込まないため）
    const s = await seedPoll({ messageId: null });
    const alice = await login(s.pollId, ALICE, "participant");
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[1] }], comment: null }, alice));
    await db().prepare("UPDATE answers SET updated_at = 100 WHERE poll_id = ?").bind(s.pollId).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const choices = [
      { id: s.choiceIds[0], symbol: "○", label: "参加", kind: "ok", score: 2, color: "green" },
      { id: s.choiceIds[1], symbol: "△", label: "遅れて参加", kind: "maybe", score: 1, color: "yellow" },
      { id: s.choiceIds[2], symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ];
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/choices`, { choicesVersion: 1, choices, reassign: [] }, org));
    const needs = async () => ((await (await call(getReq(`/api/polls/${s.pollId}`, alice.cookie))).json()) as { me: { needsChoicesAck: boolean } }).me.needsChoicesAck;
    expect(await needs()).toBe(true);
    // ひとことだけ保存（回答は同じ）
    await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 2, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[1] }], comment: "よろしく" }, alice));
    expect(await needs()).toBe(true);
    expect((await call(jsonReq("POST", `/api/polls/${s.pollId}/choices-ack`, {}, alice))).status).toBe(200);
    expect(await needs()).toBe(false);
  });

  it("主催者の未反映の件数は、読み込んだ回答から数える", async () => {
    const s = await seedPoll();
    await db().prepare("UPDATE polls SET last_synced_at = 50 WHERE id = ?").bind(s.pollId).run();
    await db().prepare("INSERT INTO answers (poll_id, slot_id, user_id, choice_id, updated_at) VALUES (?, ?, ?, ?, 100), (?, ?, ?, ?, 10)").bind(s.pollId, s.slotIds[0], ALICE, s.choiceIds[0], s.pollId, s.slotIds[1], ALICE, s.choiceIds[0]).run();
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const data = (await (await call(getReq(`/api/polls/${s.pollId}`, org.cookie))).json()) as { poll: { pendingChanges: number } };
    expect(data.poll.pendingChanges).toBe(1);
  });
});

describe("8 回目のレビューのあとの確認", () => {
  it("参加者に入っていない主催者のセッションでは、回答を保存できない", async () => {
    const s = await seedPoll({ participants: [ALICE, BOB] });
    const org = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("PUT", `/api/polls/${s.pollId}/answers/me`, { choicesVersion: 1, answers: [{ slotId: s.slotIds[0], choiceId: s.choiceIds[0] }], comment: null }, org));
    expect(res.status).toBe(403);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM answers WHERE poll_id = ?").bind(s.pollId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

