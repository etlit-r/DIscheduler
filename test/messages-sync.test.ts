// 募集メッセージの組み立てと更新（Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerRow, ChoiceRow, ParticipantRow, PollRow, SlotRow } from "../src/db";
import type { Env } from "../src/core/env";
import { nowSec } from "../src/core/lib";
import {
  buildAnnounceMessage,
  buildDayReminderMessage,
  buildDeletedMessage,
  buildFixedMessage,
  buildMentionMessage,
  buildPollMessage,
  escapeMarkdown,
  messageLink,
} from "../src/discord/messages";
import { SYNC_INTERVAL, syncAfterAnswer, syncNow } from "../src/polls/sync";
import { CHANNEL, mockDiscord, seedPoll, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;
const ROLE = "600000000000000001";

function poll(over: Partial<PollRow> = {}): PollRow {
  return {
    id: "P".repeat(22),
    guild_id: "1",
    channel_id: "2",
    message_id: "3",
    organizer_id: "4",
    title: "定例会",
    description: null,
    timezone: "Asia/Tokyo",
    timezone_set: 0,
    target_type: "channel",
    target_id: null,
    join_policy: "closed",
    status: "open",
    deadline_at: null,
    fixed_slot_id: null,
    fixed_at: null,
    discord_event_id: null,
    choices_version: 1,
    last_synced_at: null,
    last_reminded_at: null,
    publishing_at: null,
    remind_day_offset: 0,
    remind_hour: 17,
    day_reminded_slot_at: null,
    choices_changed_at: null,
    created_at: 0,
    ...over,
  } as PollRow;
}
const slot = (id: string, start: number, over: Partial<SlotRow> = {}): SlotRow =>
  ({ id, poll_id: "p", start_at: start, end_at: null, all_day: 0, position: 0, fixed_at: null, discord_event_id: null, announced_fixed: 0, day_reminded_at: null, ...over }) as SlotRow;
const choices: ChoiceRow[] = [
  { id: "ok", poll_id: "p", symbol: "○", label: "参加", kind: "ok", score: 4, color: "green", position: 0 },
  { id: "ok2", poll_id: "p", symbol: "◎", label: "ぜひ", kind: "ok", score: 5, color: "green", position: 1 },
  { id: "ng", poll_id: "p", symbol: "×", label: "不可", kind: "ng", score: 0, color: "red", position: 2 },
];
const participants = ["u1", "u2", "u3"].map((u) => ({ poll_id: "p", user_id: u, display_name: u, comment: null, answered_at: null, choices_ack_version: null }) as ParticipantRow);
const ans = (slotId: string, user: string, choice: string) => ({ poll_id: "p", slot_id: slotId, user_id: user, choice_id: choice, prev_choice_id: null, updated_at: 0 }) as AnswerRow;

describe("募集メッセージの組み立て", () => {
  const now = 1_800_000_000;
  const slots = [slot("a", 1_800_100_000, { end_at: 1_800_103_600 }), slot("b", 1_800_200_000), slot("c", 1_800_300_000, { all_day: 1 })];

  it("募集中: 締切、回答率、候補ごとの「参加できる」の人数と ★", () => {
    const m = buildPollMessage({
      poll: poll({ deadline_at: 1_800_050_000, description: "説明 *強調*" }),
      slots,
      choices,
      participants,
      answers: [ans("a", "u1", "ok"), ans("a", "u2", "ng"), ans("b", "u1", "ok2"), ans("b", "u2", "ok")],
      now,
    });
    expect(m.content).toBe("");
    expect(m.allowed_mentions).toEqual({ parse: [] });
    const e = m.embeds[0]!;
    expect(e.title).toBe("定例会");
    expect(e.color).toBe(0x4f46e5);
    expect(e.footer).toEqual({ text: "DIscheduler" });
    expect(e.description.split("\n")).toEqual([
      "説明 \\*強調\\*",
      "",
      "締切: <t:1800050000:f>（<t:1800050000:R>）",
      "回答: 2/3 名",
      "",
      "**候補**（○◎ の人数）",
      "・ <t:1800100000:f>〜<t:1800103600:t>　1 人",
      "★ <t:1800200000:f>〜　2 人",
      "・ <t:1800300000:D> 終日　0 人",
      "",
      "［回答する］から、あなた専用の入力画面を開けます。回答は参加者同士で共有されます。",
    ]);
    expect(m.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "回答する", custom_id: `answer:${"P".repeat(22)}` },
          { type: 2, style: 2, label: "集計を見る", custom_id: `view:${"P".repeat(22)}` },
          { type: 2, style: 2, label: "使い方", custom_id: "help" },
        ],
      },
    ]);
  });

  it("締切を過ぎたら締切の行を変える。締切なしなら締切の行を出さない", () => {
    const closed = buildPollMessage({ poll: poll({ deadline_at: now - 1 }), slots, choices, participants, answers: [], now });
    expect(closed.embeds[0]!.description.split("\n")[0]).toBe("締切を過ぎました（回答の入力・変更はできます）");
    const none = buildPollMessage({ poll: poll(), slots, choices, participants, answers: [], now });
    expect(none.embeds[0]!.description.split("\n")[0]).toBe("回答: 0/3 名");
    expect(none.embeds[0]!.title).toBe("定例会");
    expect(buildPollMessage({ poll: poll({ title: null }), slots, choices, participants, answers: [], now }).embeds[0]!.title).toBe("日程調整");
  });

  it("確定: 確定した候補ごとに人数を出し、緑色にする", () => {
    const fixedSlots = [slots[0]!, { ...slots[1]!, fixed_at: 1 }, { ...slots[2]!, fixed_at: 1 }];
    const m = buildPollMessage({ poll: poll({ status: "fixed", deadline_at: now + 100 }), slots: fixedSlots, choices, participants, answers: [ans("b", "u1", "ok")], now });
    expect(m.embeds[0]!.color).toBe(0x157f4c);
    expect(m.embeds[0]!.description.split("\n").slice(0, 4)).toEqual([
      "**確定: <t:1800200000:f>〜**（参加できる人: 1 人）",
      "**確定: <t:1800300000:D> 終日**（参加できる人: 0 人）",
      `（人数は <t:${now}:f> 時点）`,
      "回答: 1/3 名",
    ]);
    expect(m.embeds[0]!.description).toContain("✅ <t:1800200000:f>〜　1 人");
  });

  it("確定の状態でも、確定した候補がなければ締切を出す", () => {
    const m = buildPollMessage({ poll: poll({ status: "fixed", deadline_at: now + 100 }), slots, choices, participants, answers: [], now });
    expect(m.embeds[0]!.description.split("\n")[0]).toBe(`締切: <t:${now + 100}:f>（<t:${now + 100}:R>）`);
    expect(m.embeds[0]!.color).toBe(0x157f4c);
  });

  it("長いタイトル・説明は切り詰める", () => {
    const m = buildPollMessage({ poll: poll({ title: "あ".repeat(300), description: "い".repeat(5000) }), slots, choices, participants, answers: [], now });
    expect(m.embeds[0]!.title).toHaveLength(256);
    expect(m.embeds[0]!.description).toHaveLength(4000);
  });

  it("削除のお知らせ", () => {
    expect(buildDeletedMessage("a_b")).toEqual({
      content: "",
      embeds: [{ title: "a\\_b", description: "この調整は主催者によって削除されました。", color: 0x888888 }],
      components: [],
      allowed_mentions: { parse: [] },
    });
    expect(buildDeletedMessage(null).embeds[0]!.title).toBe("日程調整");
  });

  it("ユーザーへのメンションは 100 人まで、本文は 2000 文字まで", () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i));
    const m = buildMentionMessage("本文", ids);
    expect(m.allowed_mentions).toEqual({ parse: [], users: ids.slice(0, 100) });
    expect(m.content.startsWith("本文\n<@0> <@1> ")).toBe(true);
    expect(m.content).not.toContain("<@100>");
    expect(buildMentionMessage("x".repeat(3000), ["1"]).content).toHaveLength(2000);
  });

  it("公開のお知らせ: ロールの調整はロール、それ以外は @everyone。募集メッセージへの返信にする", () => {
    expect(buildAnnounceMessage({ title: "会", target_type: "role", target_id: ROLE }, "9")).toEqual({
      content: `**会** の募集を始めました。募集メッセージの［回答する］から入力できます。\n<@&${ROLE}>`,
      allowed_mentions: { parse: [], roles: [ROLE], replied_user: false },
      message_reference: { message_id: "9", fail_if_not_exists: false },
    });
    expect(buildAnnounceMessage({ title: null, target_type: "channel", target_id: null }, "9")).toEqual({
      content: "**日程調整** の募集を始めました。募集メッセージの［回答する］から入力できます。\n@everyone",
      allowed_mentions: { parse: ["everyone"], replied_user: false },
      message_reference: { message_id: "9", fail_if_not_exists: false },
    });
    // ロールの ID が不正・ロール以外の種類なら @everyone
    for (const p of [
      { title: "会", target_type: "role" as const, target_id: "abc" },
      { title: "会", target_type: "role" as const, target_id: `x${ROLE}` },
      { title: "会", target_type: "role" as const, target_id: `${ROLE}x` },
      { title: "会", target_type: "role" as const, target_id: null },
      { title: "会", target_type: "manual" as const, target_id: ROLE },
    ]) {
      expect(buildAnnounceMessage(p, "9").content.endsWith("\n@everyone"), String(p.target_id)).toBe(true);
    }
  });

  it("予定のリマインド: 終日は日付、時刻のある予定はタイムスタンプ。メッセージがあればリンクと返信", () => {
    const p = { title: "会", target_type: "channel" as const, target_id: null, guild_id: "1", channel_id: "2", message_id: "3" };
    const timed = buildDayReminderMessage(p, { startAt: 1_800_000_000, allDay: false, timezone: "Asia/Tokyo" });
    expect(timed.content).toBe("**会** は <t:1800000000:f> からです。\nhttps://discord.com/channels/1/2/3\n@everyone");
    expect(timed.message_reference).toEqual({ message_id: "3", fail_if_not_exists: false });
    const allDay = buildDayReminderMessage({ ...p, message_id: null, title: null }, { startAt: Date.parse("2026-11-06T15:00:00Z") / 1000, allDay: true, timezone: "Asia/Tokyo" });
    expect(allDay.content).toBe("**日程調整** は 11/7(土) です（終日）。\n@everyone");
    expect("message_reference" in allDay).toBe(false);
  });

  it("確定のお知らせ: 確定・取り消しの一覧と、メンションの有無", () => {
    const p = { title: "会", target_type: "role" as const, target_id: ROLE };
    const m = buildFixedMessage(p, [{ when: "11/7", note: "2 時間後" }, { when: "11/8", note: null }], ["11/1"], true);
    expect(m).toEqual({
      content: `**会** の日程のお知らせ\n確定した日時:\n・11/7（2 時間後）\n・11/8\n確定を取り消した日時:\n・~~11/1~~\n<@&${ROLE}>`,
      allowed_mentions: { parse: [], roles: [ROLE], replied_user: false },
    });
    expect(buildFixedMessage({ ...p, title: null }, [], [], false)).toEqual({
      content: "**日程調整** の日程のお知らせ\n確定している日時はありません。",
      allowed_mentions: { parse: [] },
    });
  });

  it("Markdown の記号をすべてエスケープし、メッセージのリンクを作る", () => {
    expect(escapeMarkdown("\\*_~`|>#[]()-:<@x")).toBe("\\\\\\*\\_\\~\\`\\|\\>\\#\\[\\]\\(\\)\\-\\:\\<\\@x");
    expect(messageLink("1", "2", "3")).toBe("https://discord.com/channels/1/2/3");
  });
});

describe("募集メッセージの更新", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const row = (id: string) => db().prepare("SELECT message_id, last_synced_at FROM polls WHERE id = ?").bind(id).first<{ message_id: string | null; last_synced_at: number | null }>();

  it("更新できたら true。間隔の内側なら更新しない", async () => {
    const { pollId } = await seedPoll();
    const calls = mockDiscord();
    expect(await syncNow(testEnv(), pollId)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PATCH", path: `/channels/${CHANNEL}/messages/500000000000000001` });
    expect((await row(pollId))!.last_synced_at).toBeGreaterThanOrEqual(nowSec() - 1);
    expect(await syncNow(testEnv(), pollId, SYNC_INTERVAL)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await syncNow(testEnv(), pollId)).toBe(true);
  });

  it("失敗したら最終更新時刻を戻す。404 ならメッセージの ID も消す", async () => {
    const { pollId } = await seedPoll();
    await db().prepare("UPDATE polls SET last_synced_at = 5 WHERE id = ?").bind(pollId).run();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDiscord(() => new Response("{}", { status: 400 }));
    expect(await syncNow(testEnv(), pollId)).toBe(false);
    expect(await row(pollId)).toEqual({ message_id: "500000000000000001", last_synced_at: 5 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('"event":"sync_failed"'));
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockDiscord(() => new Response("{}", { status: 404 }));
    expect(await syncNow(testEnv(), pollId)).toBe(false);
    expect(await row(pollId)).toEqual({ message_id: null, last_synced_at: 5 });
  });

  it("メッセージがなければ何もしない", async () => {
    const { pollId } = await seedPoll({ messageId: null });
    const calls = mockDiscord();
    expect(await syncNow(testEnv(), pollId)).toBe(false);
    expect(calls).toHaveLength(0);
    await syncAfterAnswer(testEnv(), pollId);
    expect(calls).toHaveLength(0);
  });

  it("回答の保存のあと: 間隔の外ならすぐ更新し、内側なら区切りまで待って 1 回だけ更新する", async () => {
    const { pollId } = await seedPoll();
    const calls = mockDiscord();
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(nowSec() - SYNC_INTERVAL - 1, pollId).run();
    await syncAfterAnswer(testEnv(), pollId);
    expect(calls).toHaveLength(1);

    // 区切りまで 20 秒（vi.waitFor が偽のタイマーを少しずつ進めても、待ちが終わらない長さにする）。
    // 待っているあいだは更新せず、区切りが過ぎたら 1 回だけ更新する
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(nowSec() - 1, pollId).run();
    const p = syncAfterAnswer(testEnv(), pollId);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + (SYNC_INTERVAL + 1) * 1000);
    await vi.runAllTimersAsync();
    await p;
    expect(calls).toHaveLength(2);
  });

  it("ちょうど今更新したばかりなら、区切り（21 秒後）まで待って更新する", async () => {
    const { pollId } = await seedPoll();
    const calls = mockDiscord();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(nowSec(), pollId).run();
    const p = syncAfterAnswer(testEnv(), pollId);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    vi.setSystemTime(Date.now() + (SYNC_INTERVAL + 2) * 1000);
    await vi.runAllTimersAsync();
    await p;
    expect(calls).toHaveLength(1);
  });

  it("まだ一度も更新できていなければ（最初の更新に失敗したら）、後追いしない", async () => {
    const { pollId } = await seedPoll();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = mockDiscord(() => new Response("{}", { status: 500 }));
    await syncAfterAnswer(testEnv(), pollId);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect((await db().prepare("SELECT last_synced_at FROM polls WHERE id = ?").bind(pollId).first<{ last_synced_at: number | null }>())!.last_synced_at).toBeNull();
  });

  it("最終更新時刻が先の時刻なら待たずに諦める", async () => {
    const { pollId } = await seedPoll();
    const calls = mockDiscord();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(nowSec() + 60, pollId).run();
    await syncAfterAnswer(testEnv(), pollId);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("待っているあいだにほかの保存が更新していれば、重ねて更新しない", async () => {
    const { pollId } = await seedPoll();
    const calls = mockDiscord();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(nowSec() - 1, pollId).run();
    const p = syncAfterAnswer(testEnv(), pollId);
    // 待ちに入ってから（最終更新時刻を読んだあとで）、最終更新時刻が変わったことにする。
    // 変わった値は間隔の外にしておき、この確認がなければ更新してしまう状態にする
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await db().prepare("UPDATE polls SET last_synced_at = ? WHERE id = ?").bind(nowSec() - SYNC_INTERVAL - 5, pollId).run();
    await vi.runAllTimersAsync();
    await p;
    expect(calls).toHaveLength(0);
  });
});
