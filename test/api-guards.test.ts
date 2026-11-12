// Web API の入力の検証と分岐（Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { issueLink } from "../src/auth";
import { DAY, nowSec } from "../src/core/lib";
import { RETENTION } from "../src/polls/create";
import { ALICE, BOB, call, errorOf, getReq, GUILD, jsonReq, login, mockDiscord, ORGANIZER, ORIGIN, pollRow, seedPoll, testEnv, tokenFromUrl, type DiscordCall } from "./helpers";

const db = () => (env as unknown as Env).DB;

let calls: DiscordCall[];
beforeEach(() => {
  calls = mockDiscord();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("共通の前処理", () => {
  it("メンテナンス中はどの API も 503", async () => {
    const res = await call(getReq("/api/polls/AAAAAAAAAAAAAAAAAAAAAA"), testEnv({ MAINTENANCE: "1" }));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("maintenance");
    expect((await call(getReq("/api/polls/AAAAAAAAAAAAAAAAAAAAAA"), testEnv({ MAINTENANCE: "0" }))).status).toBe(401);
  });

  it("Origin が無い・違う POST は 403。GET には Origin を求めない", async () => {
    expect((await errorOf(await call(jsonReq("POST", "/api/session", { token: "x" }, { origin: null })))).code).toBe("bad_origin");
    expect((await errorOf(await call(jsonReq("POST", "/api/session", { token: "x" }, { origin: "https://evil.example" })))).code).toBe("bad_origin");
    expect((await errorOf(await call(jsonReq("POST", "/api/session", { token: "x" }, { origin: `${ORIGIN}.evil` })))).code).toBe("bad_origin");
  });

  it("Content-Type は application/json（大文字小文字は問わない）だけを受け付ける", async () => {
    expect((await errorOf(await call(jsonReq("POST", "/api/session", { token: "x" }, { contentType: "text/plain" })))).code).toBe("bad_content_type");
    const r = await call(new Request(`${ORIGIN}/api/session`, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }));
    expect((await errorOf(r)).code).toBe("bad_content_type");
    // 形式は通り、中身の検証で 400 になる
    expect((await errorOf(await call(jsonReq("POST", "/api/session", { token: "x" }, { contentType: "Application/JSON; charset=utf-8" })))).code).toBe("invalid");
  });

  it("本文が上限（32 KiB）を超えたら 413。ちょうど上限なら通す", async () => {
    // 本文の長さどおりの Content-Length が付く。{"token":"…"} の 12 文字を除いた分をトークンにする
    const mk = (bytes: number) => call(jsonReq("POST", "/api/session", { token: "a".repeat(bytes - 12) }));
    expect((await errorOf(await mk(32 * 1024 + 1))).code).toBe("too_large");
    // 長さの検査は通り、トークンの形式の検証で 400 になる
    expect((await errorOf(await mk(32 * 1024))).code).toBe("invalid");
  });

  it("本文そのものが上限を超えたら 413", async () => {
    const body = JSON.stringify({ token: "a".repeat(32 * 1024) });
    const req = new Request(`${ORIGIN}/api/session`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body });
    req.headers.delete("Content-Length");
    expect((await errorOf(await call(req))).code).toBe("too_large");
  });

  it("JSON でなければ bad_json。検証のエラーは日本語の文を返す", async () => {
    const bad = new Request(`${ORIGIN}/api/session`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{" });
    expect((await errorOf(await call(bad))).code).toBe("bad_json");
    const e = await errorOf(await call(jsonReq("POST", "/api/session", { token: "x" })));
    expect(e).toEqual({ code: "invalid", message: "入力内容が正しくありません。" });
  });
});

describe("入力リンクの交換", () => {
  it("用途ごとの画面に移る", async () => {
    const { pollId } = await seedPoll();
    const go = async (purpose: "edit" | "answer" | "view", user = ALICE, role: "organizer" | "participant" = "participant") => {
      const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, user, role, purpose));
      return ((await (await call(jsonReq("POST", "/api/session", { token }))).json()) as { redirect: string }).redirect;
    };
    expect(await go("edit", ORGANIZER, "organizer")).toBe(`/p/${pollId}/edit`);
    expect(await go("answer")).toBe(`/p/${pollId}/answer`);
    expect(await go("view")).toBe(`/p/${pollId}`);
  });

  it("使用済みのリンクは、種類に合わせて受け取り方を案内する", async () => {
    const { pollId } = await seedPoll();
    const expired = async (purpose: "edit" | "answer" | "view") => {
      const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", purpose));
      await call(jsonReq("POST", "/api/session", { token }));
      return (await errorOf(await call(jsonReq("POST", "/api/session", { token })))).message;
    };
    expect(await expired("answer")).toContain("［回答する］を、もう一度押してください。");
    expect(await expired("view")).toContain("［集計を見る］を、もう一度押してください。");
    expect(await expired("edit")).toContain("新しいリンクを受け取ってください。");
    const unknown = (await errorOf(await call(jsonReq("POST", "/api/session", { token: "B".repeat(43) })))).message;
    expect(unknown).toContain("参加者はチャンネルの募集メッセージの");
    expect(unknown).toMatch(/^リンクの有効期限が切れているか/);
  });

  it("削除した調整のリンクは 404", async () => {
    const { pollId } = await seedPoll({ status: "cancelled" });
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ALICE, "participant", "answer"));
    const res = await call(jsonReq("POST", "/api/session", { token }));
    expect(res.status).toBe(404);
  });
});

describe("調整のセッション", () => {
  it("ID の形式が違えば 404", async () => {
    expect((await call(getReq("/api/polls/short"))).status).toBe(404);
    expect((await call(getReq(`/api/polls/${"A".repeat(23)}`))).status).toBe(404);
  });

  it("削除した調整は、詳細以外の API でも 404", async () => {
    const { pollId } = await seedPoll();
    const { cookie, csrf } = await login(pollId, ORGANIZER, "organizer", "edit");
    await db().prepare("UPDATE polls SET status = 'cancelled' WHERE id = ?").bind(pollId).run();
    expect((await call(getReq(`/api/polls/${pollId}`, cookie))).status).toBe(404);
    expect((await call(jsonReq("PATCH", `/api/polls/${pollId}`, { title: "x" }, { cookie, csrf }))).status).toBe(404);
  });

  it("CSRF トークンが違えば 403", async () => {
    const { pollId } = await seedPoll();
    const { cookie, csrf } = await login(pollId, ORGANIZER, "organizer", "edit");
    const res = await call(jsonReq("PATCH", `/api/polls/${pollId}`, { title: "x" }, { cookie, csrf: `${csrf.slice(1)}A` }));
    expect((await errorOf(res)).code).toBe("bad_csrf");
  });

  it("主催者でも、別人の調整の主催者セッションでは主催者の操作ができない", async () => {
    const { pollId } = await seedPoll();
    const { cookie, csrf } = await login(pollId, ALICE, "organizer", "edit");
    const res = await call(jsonReq("PATCH", `/api/polls/${pollId}`, { title: "x" }, { cookie, csrf }));
    expect((await errorOf(res)).code).toBe("forbidden");
  });
});

describe("調整の変更（PATCH）", () => {
  async function organizer(opts: Parameters<typeof seedPoll>[0] = {}) {
    const s = await seedPoll(opts);
    const auth = await login(s.pollId, ORGANIZER, "organizer", "edit");
    const patch = (body: unknown) => call(jsonReq("PATCH", `/api/polls/${s.pollId}`, body, auth));
    return { ...s, patch };
  }

  it("ほかの画面で変更されていたら 409。同じ updatedAt なら保存する", async () => {
    const { pollId, patch } = await organizer();
    const updatedAt = (await pollRow(pollId))!.updated_at as number;
    expect((await patch({ updatedAt: updatedAt - 1, title: "x" })).status).toBe(409);
    expect((await patch({ updatedAt, title: "新しい題" })).status).toBe(200);
    const row = await pollRow(pollId);
    expect(row!.title).toBe("新しい題");
    expect(row!.updated_at as number).toBeGreaterThanOrEqual(updatedAt);
  });

  it("説明は前後の空白を落とし、空なら null にする", async () => {
    const { pollId, patch } = await organizer();
    await patch({ description: "  説明\n2 行目  " });
    expect((await pollRow(pollId))!.description).toBe("説明\n2 行目");
    await patch({ description: "   " });
    expect((await pollRow(pollId))!.description).toBeNull();
    await patch({ description: "a" });
    await patch({ description: null });
    expect((await pollRow(pollId))!.description).toBeNull();
  });

  it("締切は 1 日前から 1 年後まで。分単位に切り捨てて保存し、削除時刻も延ばす", async () => {
    const { pollId, patch } = await organizer();
    const now = nowSec();
    expect((await patch({ deadlineAt: now - DAY - 120 })).status).toBe(400);
    expect((await patch({ deadlineAt: now + 365 * DAY + 120 })).status).toBe(400);
    expect((await patch({ deadlineAt: now - DAY + 120 })).status).toBe(200);
    const target = now + 365 * DAY - 120;
    expect((await patch({ deadlineAt: target })).status).toBe(200);
    const row = await pollRow(pollId);
    expect(row!.deadline_at).toBe(target - (target % 60));
    expect(row!.purge_after).toBe(target + RETENTION);
  });

  it("締め切った調整の締切を先に延ばすと募集中に戻す。過去のままなら締め切ったまま", async () => {
    const { pollId, patch } = await organizer({ status: "closed", deadlineAt: nowSec() - 3600 });
    await patch({ deadlineAt: nowSec() - 600 });
    expect((await pollRow(pollId))!.status).toBe("closed");
    await patch({ deadlineAt: nowSec() + 3600 });
    expect((await pollRow(pollId))!.status).toBe("open");
  });

  it("下書きと確定済みでは、締切を変えても削除時刻を変えない", async () => {
    for (const status of ["draft", "fixed"]) {
      const { pollId, patch } = await organizer({ status });
      const before = (await pollRow(pollId))!.purge_after;
      await patch({ deadlineAt: nowSec() + 30 * DAY });
      expect((await pollRow(pollId))!.purge_after, status).toBe(before);
    }
  });

  it("タイムゾーン: 不正なら 400。主催者が選んだあとは、ブラウザの自動設定で上書きしない", async () => {
    const { pollId, patch } = await organizer();
    expect((await patch({ timezone: "Mars/Base" })).status).toBe(400);
    await patch({ timezone: "Europe/Paris", timezoneAuto: true });
    expect(await pollRow(pollId)).toMatchObject({ timezone: "Europe/Paris", timezone_set: 0 });
    await patch({ timezone: "America/New_York" });
    expect(await pollRow(pollId)).toMatchObject({ timezone: "America/New_York", timezone_set: 1 });
    await patch({ timezone: "Europe/Paris", timezoneAuto: true });
    expect(await pollRow(pollId)).toMatchObject({ timezone: "America/New_York", timezone_set: 1 });
    await patch({ timezone: "Asia/Tokyo", timezoneAuto: false });
    expect(await pollRow(pollId)).toMatchObject({ timezone: "Asia/Tokyo", timezone_set: 1 });
  });

  it("参加の受け付け方を変えられる", async () => {
    const { pollId, patch } = await organizer();
    await patch({ joinPolicy: "open" });
    expect((await pollRow(pollId))!.join_policy).toBe("open");
  });

  it("公開後は参加者の決め方を変えられない", async () => {
    const { patch } = await organizer();
    expect((await errorOf(await patch({ members: "manual" }))).code).toBe("published");
    expect((await errorOf(await patch({ roleId: null }))).code).toBe("published");
  });

  it("何も変えなければ更新時刻も変えず、募集メッセージも更新しない", async () => {
    const { pollId, patch } = await organizer();
    await db().prepare("UPDATE polls SET updated_at = 1 WHERE id = ?").bind(pollId).run();
    expect(await (await patch({})).json()).toEqual({ ok: true, notice: null });
    expect((await pollRow(pollId))!.updated_at).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("公開中の調整を変えると、募集メッセージを更新する。下書きなら更新しない", async () => {
    const open = await organizer();
    await open.patch({ title: "x" });
    expect(calls.some((c) => c.method === "PATCH" && c.path.includes("/messages/"))).toBe(true);
    calls.length = 0;
    const draft = await organizer({ status: "draft", messageId: null });
    await draft.patch({ title: "y" });
    expect(calls).toHaveLength(0);
  });
});

describe("メンバー検索・ロール・ボイスチャンネル", () => {
  it("検索語が空か長すぎれば Discord に問い合わせない", async () => {
    const { pollId } = await seedPoll();
    const { cookie } = await login(pollId, ORGANIZER, "organizer", "edit");
    for (const q of ["", "%20%20", "a".repeat(33)]) {
      const res = await call(getReq(`/api/polls/${pollId}/member-search?q=${q}`, cookie));
      expect(await res.json()).toEqual({ members: [] });
    }
    expect(calls).toHaveLength(0);
    vi.restoreAllMocks();
    calls = mockDiscord(() => []);
    const res = await call(getReq(`/api/polls/${pollId}/member-search?q=${"a".repeat(32)}`, cookie));
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.path)).toEqual([`/guilds/${GUILD}/members/search?query=${"a".repeat(32)}&limit=25`]);
  });

  it("検索の権限がなければ 502、それ以外の失敗は 500", async () => {
    const { pollId } = await seedPoll();
    const { cookie } = await login(pollId, ORGANIZER, "organizer", "edit");
    vi.restoreAllMocks();
    mockDiscord(() => new Response("{}", { status: 403 }));
    expect((await errorOf(await call(getReq(`/api/polls/${pollId}/member-search?q=a`, cookie)))).code).toBe("discord_forbidden");
    vi.restoreAllMocks();
    mockDiscord(() => new Response("{}", { status: 400 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call(getReq(`/api/polls/${pollId}/member-search?q=a`, cookie))).status).toBe(500);
  });

  it("ロールは @everyone と連携ロールを除き、上位から並べる", async () => {
    const { pollId } = await seedPoll();
    const { cookie } = await login(pollId, ORGANIZER, "organizer", "edit");
    vi.restoreAllMocks();
    mockDiscord(() => [
      { id: GUILD, name: "@everyone", position: 0, managed: false },
      { id: "1", name: "下", position: 1, managed: false },
      { id: "2", name: "bot", position: 5, managed: true },
      { id: "3", name: "上".repeat(120), position: 3, managed: false },
    ]);
    const body = (await (await call(getReq(`/api/polls/${pollId}/roles`, cookie))).json()) as { roles: { id: string; name: string }[] };
    expect(body.roles).toEqual([
      { id: "3", name: "上".repeat(100) },
      { id: "1", name: "下" },
    ]);
  });

  it("ボイスチャンネルとステージチャンネルだけを返す", async () => {
    const { pollId } = await seedPoll();
    const { cookie } = await login(pollId, ORGANIZER, "organizer", "edit");
    vi.restoreAllMocks();
    mockDiscord(() => [
      { id: "1", type: 0, name: "text" },
      { id: "2", type: 2, name: "voice" },
      { id: "3", type: 13, name: "stage" },
      { id: "4", type: 2 },
    ]);
    const body = await (await call(getReq(`/api/polls/${pollId}/voice-channels`, cookie))).json();
    expect(body).toEqual({
      channels: [
        { id: "2", name: "voice" },
        { id: "3", name: "stage" },
        { id: "4", name: "" },
      ],
    });
  });
});

describe("参加者の追加・削除", () => {
  it("上限を超える追加は拒否する。削除する人の分は差し引いて数える", async () => {
    const many = Array.from({ length: 99 }, (_, i) => String(400000000000000100n + BigInt(i)));
    const { pollId } = await seedPoll({ participants: many, status: "draft", messageId: null });
    const auth = await login(pollId, ORGANIZER, "organizer", "edit");
    const put = (body: unknown) => call(jsonReq("PUT", `/api/polls/${pollId}/participants`, body, auth));
    expect((await errorOf(await put({ add: [ALICE, BOB], remove: [] }))).code).toBe("too_many");
    vi.restoreAllMocks();
    mockDiscord((c) => ({ user: { id: c.path.split("/").pop(), username: "u" } }));
    const res = await put({ add: [ALICE, BOB], remove: [many[0]] });
    expect(await res.json()).toEqual({ ok: true, added: 2, notFound: 0 });
    // すでにいる人は数えない（100 人ちょうど）
    expect((await put({ add: [ALICE], remove: [] })).status).toBe(200);
  });

  it("見つからない人は notFound に数える。外した人のセッションは消すが、主催者自身のセッションは残す", async () => {
    const { pollId } = await seedPoll({ status: "draft", messageId: null });
    const auth = await login(pollId, ORGANIZER, "organizer", "edit");
    const alice = await login(pollId, ALICE, "participant", "answer");
    vi.restoreAllMocks();
    mockDiscord((c) => (c.path.endsWith(BOB) ? new Response("{}", { status: 404 }) : { user: { id: "400000000000000077", username: "u" } }));
    await db().prepare("DELETE FROM participants WHERE poll_id = ? AND user_id = ?").bind(pollId, BOB).run();
    const res = await call(jsonReq("PUT", `/api/polls/${pollId}/participants`, { add: [BOB, "400000000000000077"], remove: [ALICE, ORGANIZER] }, auth));
    expect(await res.json()).toEqual({ ok: true, added: 1, notFound: 1 });
    expect((await call(getReq(`/api/polls/${pollId}`, alice.cookie))).status).toBe(401);
    expect((await call(getReq(`/api/polls/${pollId}`, auth.cookie))).status).toBe(200);
  });
});
