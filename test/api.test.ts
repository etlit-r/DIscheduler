import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
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
});
