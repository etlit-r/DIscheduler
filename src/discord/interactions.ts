// Discord Interaction の処理（docs/design.md §4, §8.3）
// ユーザー ID は必ず署名済みの Interaction 本体の値を使い、custom_id の値は信用しない。
import type { Env } from "../core/env";
import { issueLink, issueListLink } from "../auth";
import { getParticipant, getPoll, hitRateLimit } from "../db";
import { AppError, isQuotaError, nowSec, QUOTA_MESSAGE } from "../core/lib";
import { createOrReuseDraft } from "../polls/create";
import { buildSettingsMessage, canManageGuild, getGuildSettings, saveGuildSettings, type DefaultMode } from "../guilds/settings";
import { canAnswer, effectiveStatus } from "../shared/model";
import { sanitizeDisplayName, sanitizeLine } from "../shared/text";
import { syncCommands } from "./commands";
import { hasPermission, PERM } from "./permissions";
import { escapeMarkdown, messageLink, NO_MENTIONS } from "./messages";
import { discord, memberDisplayName, type DiscordMember } from "./rest";

const EPHEMERAL = 64;

interface Interaction {
  type: number;
  id: string;
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  member?: DiscordMember & { permissions?: string };
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    options?: { name: string; type: number; value: string | number }[];
  };
}

type Ctx = { waitUntil(p: Promise<unknown>): void };

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const ephemeral = (content: string, components: unknown[] = []) =>
  json({ type: 4, data: { content, components, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS } });
const deferred = () => json({ type: 5, data: { flags: EPHEMERAL } });

function linkButton(label: string, url: string) {
  return { type: 2, style: 5, label, url };
}

/** mentionUser を渡したときは、その人へのメンションだけを有効にする（本人にだけ見える応答で、本人を強調するため） */
async function editOriginal(env: Env, i: Interaction, content: string, components: unknown[] = [], mentionUser?: string): Promise<void> {
  const allowed_mentions = mentionUser ? { parse: [] as string[], users: [mentionUser] } : NO_MENTIONS;
  await discord(env, "PATCH", `/webhooks/${i.application_id}/${i.token}/messages/@original`, { content, components, allowed_mentions }, { auth: "none" });
}

/** 応答後の処理。失敗しても利用者に理由を伝える */
function background(env: Env, ctx: Ctx, i: Interaction, work: () => Promise<void>): void {
  ctx.waitUntil(
    work().catch(async (e) => {
      const msg = isQuotaError(e)
        ? QUOTA_MESSAGE
        : e instanceof AppError
          ? e.message
          : "エラーが発生しました。時間をおいてもう一度お試しください。";
      if (!(e instanceof AppError)) console.error(JSON.stringify({ event: "interaction_error", error: e instanceof Error ? e.message : "unknown" }));
      await editOriginal(env, i, msg).catch(() => undefined);
    }),
  );
}

export async function handleInteraction(env: Env, ctx: Ctx, i: Interaction, origin: string): Promise<Response> {
  if (i.type === 1) {
    // PING（Interactions Endpoint URL の登録時にも届く）。このときにコマンドを登録・更新する
    ctx.waitUntil(syncCommands(env, { force: true }).catch((e) => console.error(JSON.stringify({ event: "commands_sync_failed", error: String(e) }))));
    return json({ type: 1 });
  }
  if (env.MAINTENANCE === "1") return ephemeral("DIscheduler は現在メンテナンス中です。しばらくしてからお試しください。");

  const userId = i.member?.user?.id;
  const guildId = i.guild_id;
  const channelId = i.channel_id ?? i.channel?.id;
  if (!userId || !guildId || !channelId) return ephemeral("DIscheduler はサーバーのチャンネルの中で使ってください。");

  ctx.waitUntil(syncCommands(env).catch(() => undefined));

  if (i.type === 2 && (i.data?.name === "schedule" || i.data?.name === "di")) {
    background(env, ctx, i, () => handleCreate(env, i, origin, guildId, channelId, userId));
    return deferred();
  }

  if (i.type === 3) {
    const id = i.data?.custom_id ?? "";
    if (id === "help") return ephemeral(helpText(origin));
    if (id === "settings" || id === "settings_mode" || id === "settings_role") {
      return handleSettings(env, i, id, guildId, userId);
    }
    // 以前の［このチャンネルの調整］ボタン（すでに送ったメッセージに残っている分）にも応える
    if (id === "list") {
      background(env, ctx, i, () => handleList(env, i, guildId, channelId));
      return deferred();
    }
    if (id === "manage") {
      background(env, ctx, i, () => handleManage(env, i, origin, guildId, userId));
      return deferred();
    }
    // 以前の［作成した調整を管理］の選択メニュー（すでに送ったメッセージに残っている分）にも応える
    if (id === "manage_select") {
      const pollId = i.data?.values?.[0] ?? "";
      const poll = await getPoll(env.DB, pollId);
      if (!poll || poll.organizer_id !== userId || poll.guild_id !== guildId) {
        return json({ type: 7, data: { content: "この調整は見つかりませんでした。", components: [] } });
      }
      const url = await issueLink(env.DB, origin, poll.id, userId, "organizer", "edit");
      return json({
        type: 7,
        data: {
          content: `「${escapeMarkdown(poll.title ?? "（タイトル未入力）")}」の管理リンクです（10 分有効・1 回限り）。他の人に渡さないでください。`,
          components: [{ type: 1, components: [linkButton("調整を開く", url)] }],
        },
      });
    }
    const m = /^(answer|view):([A-Za-z0-9_-]{22})$/.exec(id);
    if (m) {
      background(env, ctx, i, () => handlePollButton(env, i, origin, m[1] as "answer" | "view", m[2]!, guildId, channelId, userId));
      return deferred();
    }
  }
  return ephemeral("この操作には対応していません。");
}

function intOption(i: Interaction, name: string): number | null {
  const v = i.data?.options?.find((o) => o.name === name)?.value;
  return typeof v === "number" ? v : null;
}
function strOption(i: Interaction, name: string): string | null {
  const v = i.data?.options?.find((o) => o.name === name)?.value;
  return typeof v === "string" ? v : null;
}

async function handleCreate(env: Env, i: Interaction, origin: string, guildId: string, channelId: string, userId: string): Promise<void> {
  const rawTitle = strOption(i, "title");
  // 空白だけなどで空になったら、タイトルなし（Web 画面で入力する）として扱う
  const title = rawTitle ? sanitizeLine(rawTitle, 100) || null : null;
  const members = strOption(i, "members");
  const roleId = strOption(i, "role");
  const deadline = intOption(i, "deadline");
  const result = await createOrReuseDraft(env, {
    guildId,
    channelId,
    organizerId: userId,
    title,
    members: members === "auto" || members === "manual" ? members : null,
    roleId: roleId && /^\d{17,20}$/.test(roleId) ? roleId : null,
    deadlineDays: deadline && deadline >= 1 && deadline <= 90 ? Math.floor(deadline) : null,
  });
  if (!result.ok) {
    await editOriginal(env, i, result.message, menuRow(isAdmin(i)));
    return;
  }
  const url = await issueLink(env.DB, origin, result.pollId, userId, "organizer", "edit");
  const lines = [
    result.reused ? "作成途中の日程調整の下書きがあります。" : "新しい日程調整の下書きを作りました。",
    "［調整を作成する］から、タイトルや候補日時を入力して公開してください（リンクは 10 分有効・1 回限り。他の人に渡さないでください）。",
  ];
  // 参加者をロールで決めていなければ、ロールの指定をすすめる（公開時と予定のリマインドの通知が、ロールにだけ届くため。§5.5、§5.7）
  if (result.targetType !== "role") {
    lines.push("", "💡 参加者はロールで決めるのがおすすめです。公開したときと予定のリマインドで、そのロールのメンバーにだけ通知が届きます（ロールがないと @everyone で通知します）。作成画面の「参加者」か、`/schedule` の `role` で選べます。");
  }
  if (result.notice) lines.push("", `⚠️ ${result.notice}`);
  await editOriginal(env, i, lines.join("\n"), [
    { type: 1, components: [linkButton("調整を作成する", url)] },
    ...menuRow(isAdmin(i)),
  ]);
}

function isAdmin(i: Interaction): boolean {
  return canManageGuild(i.member?.permissions);
}

function menuRow(admin: boolean) {
  const buttons: unknown[] = [
    { type: 2, style: 2, label: "作成した調整を管理", custom_id: "manage" },
    { type: 2, style: 2, label: "使い方", custom_id: "help" },
  ];
  // サーバー管理の権限がある人にだけ、既定値の設定を出す（§5.3.1）
  if (admin) buttons.push({ type: 2, style: 2, label: "サーバー既定値の設定", custom_id: "settings" });
  return [{ type: 1, components: buttons }];
}

/** サーバーの既定値の表示・変更。権限は署名済みの Interaction の permissions で毎回確かめる */
async function handleSettings(env: Env, i: Interaction, id: string, guildId: string, userId: string): Promise<Response> {
  if (!isAdmin(i)) return ephemeral("サーバーの既定値を変更できるのは、「サーバー管理」の権限を持つメンバーだけです。");
  const current = await getGuildSettings(env.DB, guildId);
  if (id === "settings") return json({ type: 4, data: { ...buildSettingsMessage(current, null), flags: EPHEMERAL } });

  let next: { mode: DefaultMode; roleId: string | null } = { mode: current.mode, roleId: current.roleId };
  let note: string | null = null;
  if (id === "settings_mode") {
    const v = i.data?.values?.[0];
    if (v !== "channel" && v !== "role" && v !== "manual") return ephemeral("この操作には対応していません。");
    next = { mode: v, roleId: v === "role" ? current.roleId : null };
    if (v === "role" && !current.roleId) note = "下の欄でロールを選んでください。ロールを選ぶまでは、チャンネルのメンバーが参加者になります。";
  } else {
    const roleId = i.data?.values?.[0] ?? null;
    if (roleId !== null && !/^\d{17,20}$/.test(roleId)) return ephemeral("この操作には対応していません。");
    next = roleId ? { mode: "role", roleId } : { mode: current.mode === "role" ? "channel" : current.mode, roleId: null };
  }
  await saveGuildSettings(env.DB, guildId, next, userId);
  const saved = await getGuildSettings(env.DB, guildId);
  return json({ type: 7, data: buildSettingsMessage(saved, note ?? "保存しました。") });
}

async function handlePollButton(
  env: Env,
  i: Interaction,
  origin: string,
  kind: "answer" | "view",
  pollId: string,
  guildId: string,
  channelId: string,
  userId: string,
): Promise<void> {
  const poll = await getPoll(env.DB, pollId);
  // custom_id は改ざんできるため、調整のサーバーとチャンネルが押された場所と一致するかを確かめる
  if (!poll || poll.guild_id !== guildId || poll.channel_id !== channelId || poll.status === "draft" || poll.status === "cancelled") {
    await editOriginal(env, i, "この調整は見つかりませんでした。削除された可能性があります。");
    return;
  }
  if (!(await hitRateLimit(env.DB, `link:${userId}`, 20, 3600, nowSec()))) {
    await editOriginal(env, i, "リンクの発行回数の上限（1 時間に 20 回）に達しました。しばらくしてからお試しください。");
    return;
  }
  const isOrganizer = poll.organizer_id === userId;
  let participant = await getParticipant(env.DB, poll.id, userId);
  if (!participant && !isOrganizer) {
    const canView = hasPermission(i.member?.permissions, PERM.VIEW_CHANNEL);
    if (kind === "answer" && poll.join_policy === "open" && canView) {
      const name = sanitizeDisplayName(memberDisplayName(i.member!), 64);
      await env.DB.prepare("INSERT OR IGNORE INTO participants (poll_id, user_id, display_name) VALUES (?, ?, ?)").bind(poll.id, userId, name).run();
      participant = await getParticipant(env.DB, poll.id, userId);
    } else {
      await editOriginal(env, i, "この調整の参加者ではないため、回答・閲覧できません。参加したい場合は主催者に追加を依頼してください。");
      return;
    }
  }
  const status = effectiveStatus(poll.status, poll.deadline_at, nowSec());
  if (kind === "answer" && !participant) {
    // 主催者が参加者に入っていない場合は、集計の閲覧に切り替える
    kind = "view";
  }
  if (kind === "answer" && !canAnswer(status)) {
    await editOriginal(env, i, "この調整にはいま回答できません。");
    return;
  }
  const role = isOrganizer ? "organizer" : "participant";
  const url = await issueLink(env.DB, origin, poll.id, userId, role, kind);
  const label = kind === "answer" ? "回答する" : "集計を見る";
  const note =
    status === "fixed"
      ? "日時は確定していますが、予定が変わった場合は回答を変更できます。"
      : status === "closed"
        ? "締切を過ぎていますが、回答の入力・変更はできます。"
        : "";
  await editOriginal(
    env,
    i,
    // 応答に気づきやすくするため、押した本人をメンションする（本人にだけ見える応答なので、ほかの人には見えない）
    `<@${userId}> 「${escapeMarkdown(poll.title ?? "日程調整")}」のあなた専用のリンクです（10 分有効・1 回限り）。他の人に渡さないでください。${note ? `\n${note}` : ""}`,
    [{ type: 1, components: [linkButton(label, url)] }],
    userId,
  );
}

async function handleList(env: Env, i: Interaction, guildId: string, channelId: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, title, status, deadline_at, message_id FROM polls WHERE guild_id = ? AND channel_id = ? AND status IN ('open','closed','fixed') ORDER BY created_at DESC LIMIT 15",
  )
    .bind(guildId, channelId)
    .all<{ id: string; title: string | null; status: "open" | "closed" | "fixed"; deadline_at: number | null; message_id: string | null }>();
  if (rows.results.length === 0) {
    await editOriginal(env, i, "このチャンネルには進行中の調整はありません。");
    return;
  }
  const now = nowSec();
  const label = { open: "募集中", closed: "締切後", fixed: "確定" } as const;
  const lines = rows.results.map((r) => {
    const st = effectiveStatus(r.status, r.deadline_at, now) as "open" | "closed" | "fixed";
    const link = r.message_id ? ` ${messageLink(guildId, channelId, r.message_id)}` : "";
    return `・${escapeMarkdown(r.title ?? "（タイトルなし）")}（${label[st]}）${link}`;
  });
  await editOriginal(env, i, ["このチャンネルの調整です。回答は各募集メッセージの［回答する］から入力できます。", ...lines].join("\n"));
}

/** ［作成した調整を管理］: このサーバーで自分が主催した調整の一覧ページ（S9。§6.11）のリンクを本人にだけ返す */
async function handleManage(env: Env, i: Interaction, origin: string, guildId: string, userId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls WHERE guild_id = ? AND organizer_id = ? AND status != 'cancelled'")
    .bind(guildId, userId)
    .first<{ n: number }>();
  if (!row || row.n === 0) {
    await editOriginal(env, i, "このサーバーであなたが主催している調整はありません。`/schedule` で作成できます。");
    return;
  }
  if (!(await hitRateLimit(env.DB, `link:${userId}`, 20, 3600, nowSec()))) {
    await editOriginal(env, i, "リンクの発行回数の上限（1 時間に 20 回）に達しました。しばらくしてからお試しください。");
    return;
  }
  const url = await issueListLink(env.DB, origin, guildId, userId);
  await editOriginal(
    env,
    i,
    `このサーバーであなたが主催している調整（${row.n} 件）の一覧です。編集・集計・削除ができます。\nリンクは 10 分有効・1 回限りです。他の人に渡さないでください。`,
    [{ type: 1, components: [linkButton("作成した調整の一覧を開く", url)] }],
  );
}

export function helpText(origin: string): string {
  return [
    "**DIscheduler の使い方**",
    "1. チャンネルで `/schedule`（または `/di`）と入力して実行します。",
    "2. 届いたリンクから、タイトルと候補日時を入力して公開します。",
    "3. 参加者は募集メッセージの［回答する］から、候補ごとに選択肢を選んで保存します。",
    "4. 主催者は集計画面で日時を確定します。Discord のイベントとしても登録できます。",
    "",
    "・入力リンクは本人専用で、10 分有効・1 回限りです。他の人に渡さないでください。",
    "・回答はその調整の参加者同士で共有され、参加者以外には見えません。",
    "・サーバー管理者は「サーバー設定 → 連携サービス → DIscheduler」で、コマンドを使えるチャンネルを指定できます。",
    "・サーバー管理者は `/schedule` の［サーバー既定値の設定］で、参加者の決め方（チャンネル・ロール・手動）の既定値を決められます。",
    "",
    `案内: ${origin}/`,
    `マニュアル: ${origin}/manual/`,
    `セキュリティ方針: ${origin}/security`,
  ].join("\n");
}
