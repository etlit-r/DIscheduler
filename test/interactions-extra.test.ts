// Discord の操作の分岐（Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/core/env";
import { DAY, nowSec } from "../src/core/lib";
import { handleInteraction, helpText } from "../src/discord/interactions";
import { PERM } from "../src/discord/permissions";
import { ALICE, BOB, CHANNEL, GUILD, mockDiscord, ORGANIZER, ORIGIN, OUTSIDER, seedPoll, testEnv, type DiscordCall } from "./helpers";

type Interaction = Parameters<typeof handleInteraction>[2];
const db = () => (env as unknown as Env).DB;
const ADMIN = String(PERM.MANAGE_GUILD | PERM.VIEW_CHANNEL);
const VIEW = String(PERM.VIEW_CHANNEL);
const ROLE = "600000000000000001";

afterEach(() => vi.restoreAllMocks());

async function run(i: Partial<Interaction> & { member?: unknown }, e: Env = testEnv()) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const res = await handleInteraction(e, ctx, { id: "9", application_id: "100000000000000001", token: "tok", ...i } as Interaction, ORIGIN);
  await Promise.all(pending);
  return (await res.json()) as { type: number; data?: Record<string, unknown> };
}
const member = (id: string, permissions = VIEW) => ({ user: { id, username: `u${id.slice(-2)}` }, roles: [], permissions });
const button = (custom_id: string, user = ALICE, permissions = VIEW, values?: string[]) =>
  ({ type: 3, guild_id: GUILD, channel_id: CHANNEL, member: member(user, permissions), data: { custom_id, values } }) as Partial<Interaction>;
const edited = (calls: DiscordCall[]) => calls.filter((c) => c.path === "/webhooks/100000000000000001/tok/messages/@original").map((c) => c.body as { content: string; components: unknown[]; allowed_mentions: unknown });

describe("共通", () => {
  it("PING には応答し、コマンドを登録し直す", async () => {
    const calls = mockDiscord();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run({ type: 1 })).toEqual({ type: 1 });
    expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/commands"))).toBe(true);
  });

  it("PING でのコマンドの登録に失敗しても、応答は返す", async () => {
    mockDiscord(() => new Response("{}", { status: 500 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await db().prepare("DELETE FROM meta WHERE key = 'commands_version'").run();
    expect(await run({ type: 1 })).toEqual({ type: 1 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("commands_sync_failed"));
  });

  it("メンテナンス中・サーバーの外・未対応の操作には、本人にだけ見えるメッセージを返す", async () => {
    mockDiscord();
    const m = await run(button("help"), testEnv({ MAINTENANCE: "1" }));
    expect(m).toEqual({ type: 4, data: { content: "DIscheduler は現在メンテナンス中です。しばらくしてからお試しください。", components: [], flags: 64, allowed_mentions: { parse: [] } } });
    const outside = "DIscheduler はサーバーのチャンネルの中で使ってください。";
    expect((await run({ ...button("help"), guild_id: undefined })).data!.content).toBe(outside);
    expect((await run({ ...button("help"), channel_id: undefined })).data!.content).toBe(outside);
    expect((await run({ ...button("help"), member: undefined })).data!.content).toBe(outside);
    // channel_id が無くても channel.id があれば使える
    expect((await run({ ...button("help"), channel_id: undefined, channel: { id: CHANNEL } } as Partial<Interaction>)).data!.content).toBe(helpText(ORIGIN));
    expect((await run(button("unknown"))).data!.content).toBe("この操作には対応していません。");
    expect((await run({ type: 2, guild_id: GUILD, channel_id: CHANNEL, member: member(ALICE), data: { name: "other" } } as Partial<Interaction>)).data!.content).toBe("この操作には対応していません。");
    expect((await run(button(`answer:${"A".repeat(21)}`))).data!.content).toBe("この操作には対応していません。");
  });

  it("使い方には案内・マニュアル・セキュリティ方針のリンクを載せる", () => {
    const t = helpText("https://x.example");
    expect(t.split("\n")[0]).toBe("**DIscheduler の使い方**");
    expect(t).toContain("\n案内: https://x.example/\nマニュアル: https://x.example/manual/\nセキュリティ方針: https://x.example/security");
  });
});

describe("サーバーの既定値の設定", () => {
  const guild = GUILD;
  const settings = () => db().prepare("SELECT mode, role_id FROM guild_settings WHERE guild_id = ?").bind(guild).first<{ mode: string; role_id: string | null }>();

  it("サーバー管理の権限がなければ、見ることも変えることもできない", async () => {
    mockDiscord();
    for (const id of ["settings", "settings_mode", "settings_role"]) {
      expect((await run(button(id, ALICE, VIEW, ["manual"]))).data!.content).toContain("「サーバー管理」の権限を持つメンバーだけです");
    }
  });

  it("表示と、決め方・ロールの変更", async () => {
    mockDiscord();
    await db().prepare("DELETE FROM guild_settings WHERE guild_id = ?").bind(guild).run();
    const shown = await run(button("settings", ORGANIZER, ADMIN));
    expect(shown.type).toBe(4);
    expect(shown.data!.flags).toBe(64);
    expect(shown.data!.content).toContain("現在: 自動: コマンドを実行したチャンネルのメンバー");

    expect((await run(button("settings_mode", ORGANIZER, ADMIN, ["bogus"]))).data!.content).toBe("この操作には対応していません。");
    const role = await run(button("settings_mode", ORGANIZER, ADMIN, ["role"]));
    expect(role.type).toBe(7);
    expect(role.data!.content).toContain("下の欄でロールを選んでください。");
    expect(await settings()).toEqual({ mode: "role", role_id: null });

    expect((await run(button("settings_role", ORGANIZER, ADMIN, ["abc"]))).data!.content).toBe("この操作には対応していません。");
    const picked = await run(button("settings_role", ORGANIZER, ADMIN, [ROLE]));
    expect(picked.data!.content).toContain("保存しました。");
    expect(await settings()).toEqual({ mode: "role", role_id: ROLE });

    // ロールが選ばれていれば、ロールに切り替えてもロールを残し、案内は出さない
    await run(button("settings_mode", ORGANIZER, ADMIN, ["manual"]));
    expect(await settings()).toEqual({ mode: "manual", role_id: null });
    await run(button("settings_role", ORGANIZER, ADMIN, [ROLE]));
    const again = await run(button("settings_mode", ORGANIZER, ADMIN, ["role"]));
    expect(again.data!.content).not.toContain("下の欄でロールを選んでください。");
    expect(await settings()).toEqual({ mode: "role", role_id: ROLE });

    // ロールの選択を外すと、ロールのときはチャンネルに戻す。それ以外の決め方は変えない
    await run(button("settings_role", ORGANIZER, ADMIN, []));
    expect(await settings()).toEqual({ mode: "channel", role_id: null });
    await run(button("settings_mode", ORGANIZER, ADMIN, ["manual"]));
    await run(button("settings_role", ORGANIZER, ADMIN, []));
    expect(await settings()).toEqual({ mode: "manual", role_id: null });
  });
});

describe("［作成した調整を管理］と一覧", () => {
  it("以前の選択メニュー: 本人の調整なら管理リンク、それ以外は見つからない", async () => {
    mockDiscord();
    const { pollId } = await seedPoll();
    expect(await run(button("manage_select", ALICE, VIEW, [pollId]))).toEqual({ type: 7, data: { content: "この調整は見つかりませんでした。", components: [] } });
    expect((await run(button("manage_select", ORGANIZER, VIEW, []))).data!.content).toBe("この調整は見つかりませんでした。");
    const ok = await run(button("manage_select", ORGANIZER, VIEW, [pollId]));
    expect(ok.type).toBe(7);
    expect(ok.data!.content).toBe("「定例会」の管理リンクです（10 分有効・1 回限り）。他の人に渡さないでください。");
    expect(JSON.stringify(ok.data!.components)).toMatch(/"label":"調整を開く","url":"https:[^"]+\/l#t=/);
    await db().prepare("UPDATE polls SET guild_id = '200000000000000099' WHERE id = ?").bind(pollId).run();
    expect((await run(button("manage_select", ORGANIZER, VIEW, [pollId]))).data!.content).toBe("この調整は見つかりませんでした。");
  });

  it("主催した調整がなければ案内し、あれば件数と一覧のリンクを返す", async () => {
    const someone = "400000000000000055";
    const calls = mockDiscord();
    expect(await run(button("manage", someone))).toEqual({ type: 5, data: { flags: 64 } });
    expect(edited(calls)[0]!.content).toContain("あなたが主催している調整はありません");
    await db().prepare("UPDATE polls SET organizer_id = ? WHERE id = ?").bind(someone, (await seedPoll()).pollId).run();
    await db().prepare("UPDATE polls SET organizer_id = ?, status = 'cancelled' WHERE id = ?").bind(someone, (await seedPoll()).pollId).run();
    await run(button("manage", someone));
    const body = edited(calls)[1]!;
    expect(body.content).toContain("（1 件）の一覧です");
    expect(JSON.stringify(body.components)).toContain("作成した調整の一覧を開く");
  });

  it("以前の［このチャンネルの調整］: 進行中の調整を、状態とメッセージのリンクつきで並べる", async () => {
    const channel = "300000000000000077";
    const calls = mockDiscord();
    await run({ ...button("list"), channel_id: channel });
    expect(edited(calls)[0]!.content).toBe("このチャンネルには進行中の調整はありません。");
    const a = await seedPoll({ deadlineAt: nowSec() - 60 });
    const b = await seedPoll({ messageId: null });
    const c = await seedPoll({ status: "fixed" });
    const d = await seedPoll({ status: "draft" });
    for (const p of [a, b, c, d]) await db().prepare("UPDATE polls SET channel_id = ? WHERE id = ?").bind(channel, p.pollId).run();
    await db().prepare("UPDATE polls SET title = NULL WHERE id = ?").bind(b.pollId).run();
    await run({ ...button("list"), channel_id: channel });
    const lines = edited(calls)[1]!.content.split("\n");
    expect(lines[0]).toBe("このチャンネルの調整です。回答は各募集メッセージの［回答する］から入力できます。");
    expect(lines.slice(1).sort()).toEqual(
      [`・定例会（締切後） https://discord.com/channels/${GUILD}/${channel}/500000000000000001`, "・（タイトルなし）（募集中）", `・定例会（確定） https://discord.com/channels/${GUILD}/${channel}/500000000000000001`].sort(),
    );
  });
});

describe("募集メッセージのボタン", () => {
  async function press(kind: "answer" | "view", pollId: string, user = ALICE, permissions = VIEW) {
    const calls = mockDiscord();
    const r = await run(button(`${kind}:${pollId}`, user, permissions));
    expect(r).toEqual({ type: 5, data: { flags: 64 } });
    vi.restoreAllMocks();
    return edited(calls)[0]!;
  }

  it("参加者には本人をメンションしてリンクを返す。状態に応じた補足を付ける", async () => {
    const open = await seedPoll();
    const m = await press("answer", open.pollId);
    expect(m.content).toBe(`<@${ALICE}> 「定例会」のあなた専用のリンクです（10 分有効・1 回限り）。他の人に渡さないでください。`);
    expect(m.allowed_mentions).toEqual({ parse: [], users: [ALICE] });
    expect(JSON.stringify(m.components)).toContain('"label":"回答する"');
    expect(JSON.stringify((await press("view", open.pollId)).components)).toContain('"label":"集計を見る"');

    const closed = await seedPoll({ deadlineAt: nowSec() - 60 });
    expect((await press("answer", closed.pollId)).content).toContain("\n締切を過ぎていますが、回答の入力・変更はできます。");
    const fixed = await seedPoll({ status: "fixed" });
    expect((await press("answer", fixed.pollId)).content).toContain("\n日時は確定していますが、予定が変わった場合は回答を変更できます。");
  });

  it("下書き・削除済み・別のサーバーの調整は見つからない", async () => {
    for (const status of ["draft", "cancelled"]) {
      const { pollId } = await seedPoll({ status });
      expect((await press("view", pollId)).content).toContain("この調整は見つかりませんでした。");
    }
    const { pollId } = await seedPoll();
    await db().prepare("UPDATE polls SET guild_id = '200000000000000099' WHERE id = ?").bind(pollId).run();
    expect((await press("view", pollId)).content).toContain("この調整は見つかりませんでした。");
  });

  it("参加を受け付ける調整では、チャンネルを見られる人が［回答する］で参加できる", async () => {
    const { pollId } = await seedPoll({ joinPolicy: "open" });
    expect((await press("view", pollId, OUTSIDER)).content).toContain("参加者ではないため");
    expect((await press("answer", pollId, OUTSIDER, "0")).content).toContain("参加者ではないため");
    expect((await press("answer", pollId, OUTSIDER)).content).toContain("あなた専用のリンクです");
    const p = await db().prepare("SELECT display_name FROM participants WHERE poll_id = ? AND user_id = ?").bind(pollId, OUTSIDER).first<{ display_name: string }>();
    expect(p!.display_name).toBe("u99");
  });

  it("参加者に入っていない主催者は、［回答する］でも集計を見るリンクになる", async () => {
    const { pollId } = await seedPoll({ participants: [ALICE, BOB] });
    expect(JSON.stringify((await press("answer", pollId, ORGANIZER)).components)).toContain('"label":"集計を見る"');
  });

  it("リンクの発行は 1 時間に 20 回まで", async () => {
    const user = "400000000000000066";
    const { pollId } = await seedPoll({ participants: [user] });
    for (let n = 0; n < 20; n++) expect((await press("view", pollId, user)).content).toContain("あなた専用のリンクです");
    expect((await press("view", pollId, user)).content).toContain("リンクの発行回数の上限（1 時間に 20 回）");
  });
});

describe("/schedule のオプション", () => {
  function mockGuild() {
    return mockDiscord((c) => {
      if (c.path === `/channels/${CHANNEL}`) return { id: CHANNEL, type: 0, permission_overwrites: [] };
      if (c.path === `/guilds/${GUILD}`) return { owner_id: ORGANIZER };
      if (c.path === `/guilds/${GUILD}/roles`) return [{ id: GUILD, name: "@everyone", permissions: "1024", position: 0 }];
      if (c.path.startsWith(`/guilds/${GUILD}/members`)) return [member(ORGANIZER)];
      return {};
    });
  }
  const cmd = (user: string, options: { name: string; type: number; value: string | number }[], permissions = VIEW) =>
    run({ type: 2, guild_id: GUILD, channel_id: CHANNEL, member: member(user, permissions), data: { name: "schedule", options } } as Partial<Interaction>);
  const draft = (user: string) => db().prepare("SELECT title, deadline_at, target_type, target_id FROM polls WHERE organizer_id = ? AND status = 'draft' ORDER BY created_at DESC").bind(user).first<{ title: string | null; deadline_at: number | null; target_type: string; target_id: string | null }>();

  it("タイトルと締切の日数を使う。範囲外の日数・空白だけのタイトルは使わない", async () => {
    const u1 = "400000000000000201";
    let calls = mockGuild();
    await cmd(u1, [{ name: "title", type: 3, value: "  会議  " }, { name: "deadline", type: 4, value: 90 }]);
    const d1 = await draft(u1);
    expect(d1!.title).toBe("会議");
    expect(d1!.deadline_at).toBeGreaterThan(nowSec() + 89 * DAY);
    expect(d1!.deadline_at! % 60).toBe(0);
    expect(edited(calls)[0]!.content.split("\n")[0]).toBe("新しい日程調整の下書きを作りました。");

    vi.restoreAllMocks();
    calls = mockGuild();
    const u2 = "400000000000000202";
    await cmd(u2, [{ name: "title", type: 3, value: "   " }, { name: "deadline", type: 4, value: 91 }]);
    expect(await draft(u2)).toMatchObject({ title: null, deadline_at: null });

    vi.restoreAllMocks();
    mockGuild();
    const u3 = "400000000000000203";
    await cmd(u3, [{ name: "deadline", type: 4, value: 1 }, { name: "title", type: 4, value: 5 }]);
    const d3 = await draft(u3);
    expect(d3!.title).toBeNull();
    expect(d3!.deadline_at).toBeLessThanOrEqual(nowSec() + DAY);
    expect(d3!.deadline_at).toBeGreaterThan(nowSec() + DAY - 120);

    vi.restoreAllMocks();
    mockGuild();
    const u4 = "400000000000000204";
    await cmd(u4, [{ name: "deadline", type: 4, value: 0 }, { name: "deadline", type: 3, value: "5" }]);
    expect((await draft(u4))!.deadline_at).toBeNull();
  });

  it("下書きを使い回したときは、その旨を伝える。管理者には既定値の設定ボタンを出す", async () => {
    const u = "400000000000000205";
    mockGuild();
    await cmd(u, []);
    vi.restoreAllMocks();
    const calls = mockGuild();
    await cmd(u, [], ADMIN);
    const body = edited(calls)[0]!;
    expect(body.content.split("\n")[0]).toBe("作成途中の日程調整の下書きがあります。");
    expect(JSON.stringify(body.components)).toContain('"custom_id":"settings"');
    expect(JSON.stringify(body.components)).toContain('"custom_id":"manage"');
    expect(JSON.stringify(body.components)).toContain('"custom_id":"help"');
  });

  it("管理者でなければ既定値の設定ボタンを出さない", async () => {
    const calls = mockGuild();
    await cmd("400000000000000206", []);
    expect(JSON.stringify(edited(calls)[0]!.components)).not.toContain('"custom_id":"settings"');
  });

  it("参加者の決め方とロール: 不正なロール ID・決め方は使わない", async () => {
    const u = "400000000000000207";
    await db().prepare("DELETE FROM guild_settings WHERE guild_id = ?").bind(GUILD).run();
    mockGuild();
    await cmd(u, [{ name: "members", type: 3, value: "manual" }]);
    expect((await draft(u))!.target_type).toBe("manual");
    const u2 = "400000000000000208";
    vi.restoreAllMocks();
    mockGuild();
    await cmd(u2, [{ name: "members", type: 3, value: "bogus" }, { name: "role", type: 8, value: "12" }]);
    expect(await draft(u2)).toMatchObject({ target_type: "channel", target_id: null });
  });

  it("処理中のエラーは、元の応答を書き換えて伝える", async () => {
    const calls = mockGuild();
    vi.spyOn(db(), "batch").mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await cmd("400000000000000209", []);
    expect(edited(calls).at(-1)!.content).toBe("エラーが発生しました。時間をおいてもう一度お試しください。");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("interaction_error"));
  });
});
