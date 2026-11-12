// チャンネルに投稿するメッセージの組み立て（docs/design.md §5.5, §6.6）
// 個人ごとの回答は載せず、候補ごとの「参加できる」区分の人数と回答率だけを出す。
import type { ChoiceRow, ParticipantRow, PollRow, SlotRow, AnswerRow } from "../db";
import { bestSlotId, effectiveStatus, tally } from "../shared/model";
import { formatDate } from "../shared/time";

/** Discord の Markdown として解釈される記号をエスケープする */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\*_~`|>#[\]()\-:<@])/g, "\\$1");
}

function slotLabel(s: SlotRow): string {
  if (s.all_day) return `<t:${s.start_at}:D> 終日`;
  return s.end_at ? `<t:${s.start_at}:f>〜<t:${s.end_at}:t>` : `<t:${s.start_at}:f>〜`;
}

export interface MessageData {
  poll: PollRow;
  slots: SlotRow[];
  choices: ChoiceRow[];
  participants: ParticipantRow[];
  answers: AnswerRow[];
  now: number;
}

export const NO_MENTIONS = { parse: [] as string[] };

export function buildPollMessage(d: MessageData) {
  const { poll, slots, choices, participants, answers, now } = d;
  const status = effectiveStatus(poll.status, poll.deadline_at, now);
  const t = tally(
    slots.map((s) => ({ id: s.id, startAt: s.start_at })),
    choices,
    answers.map((a) => ({ slotId: a.slot_id, userId: a.user_id, choiceId: a.choice_id })),
  );
  const best = bestSlotId(slots.map((s) => ({ id: s.id, startAt: s.start_at })), t);
  const answered = new Set(answers.map((a) => a.user_id)).size;
  const okLabel = choices.filter((c) => c.kind === "ok").map((c) => c.symbol).join("");

  const lines: string[] = [];
  if (poll.description) lines.push(escapeMarkdown(poll.description), "");
  // 確定した候補は複数のことがある（§4.3）
  const fixedSlots = slots.filter((s) => s.fixed_at !== null);
  if (status === "fixed" && fixedSlots.length) {
    for (const fixed of fixedSlots) {
      lines.push(`**確定: ${slotLabel(fixed)}**（参加できる人: ${t.get(fixed.id)?.ok ?? 0} 人）`);
    }
    lines.push(`（人数は <t:${now}:f> 時点）`);
  } else if (status === "closed") {
    lines.push("締切を過ぎました（回答の入力・変更はできます）");
  } else if (poll.deadline_at) {
    lines.push(`締切: <t:${poll.deadline_at}:f>（<t:${poll.deadline_at}:R>）`);
  }
  lines.push(`回答: ${answered}/${participants.length} 名`, "", `**候補**（${okLabel} の人数）`);
  for (const s of slots) {
    const mark = s.fixed_at !== null ? "✅" : s.id === best ? "★" : "・";
    lines.push(`${mark} ${slotLabel(s)}　${t.get(s.id)?.ok ?? 0} 人`);
  }
  lines.push("", "［回答する］から、あなた専用の入力画面を開けます。回答は参加者同士で共有されます。");

  return {
    content: "",
    embeds: [
      {
        title: escapeMarkdown(poll.title ?? "日程調整").slice(0, 256),
        description: lines.join("\n").slice(0, 4000),
        color: status === "fixed" ? 0x157f4c : 0x4f46e5,
        footer: { text: "DIscheduler" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "回答する", custom_id: `answer:${poll.id}` },
          { type: 2, style: 2, label: "集計を見る", custom_id: `view:${poll.id}` },
          { type: 2, style: 2, label: "使い方", custom_id: "help" },
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

export function buildDeletedMessage(title: string | null) {
  return {
    content: "",
    embeds: [{ title: escapeMarkdown(title ?? "日程調整"), description: "この調整は主催者によって削除されました。", color: 0x888888 }],
    components: [],
    allowed_mentions: NO_MENTIONS,
  };
}

/** Discord のメッセージの本文の上限（文字数） */
export const MESSAGE_MAX = 2000;
/** 1 つのメッセージの allowed_mentions.users に入れられる人数の上限 */
const MENTION_USERS_MAX = 100;

/**
 * ユーザーへのメンション付きのお知らせ（メンションは指定したユーザーだけに限る。security-design E-3）。
 * 本文の文字数（2000）とメンションの人数（100）の上限に収まるよう、メンションを複数のメッセージに分ける。
 * 1 通目は文の後ろに、2 通目以降はメンションだけを並べる（メンションを途中で切らない）
 */
export function buildMentionMessages(text: string, userIds: readonly string[]) {
  const messages: { content: string; allowed_mentions: { parse: string[]; users: string[] } }[] = [];
  // 文は、少なくとも 1 人分のメンション（最長 24 文字）を後ろに置ける長さまでにする
  let content = text.slice(0, MESSAGE_MAX - 25);
  let users: string[] = [];
  for (const id of userIds) {
    const mention = `<@${id}>`;
    if (users.length >= MENTION_USERS_MAX || content.length + 1 + mention.length > MESSAGE_MAX) {
      messages.push({ content, allowed_mentions: { parse: [], users } });
      content = "";
      users = [];
    }
    // 文の後ろは改行、メンションどうしは空白で区切る
    content = content === "" ? mention : `${content}${users.length ? " " : "\n"}${mention}`;
    users.push(id);
  }
  messages.push({ content, allowed_mentions: { parse: [], users } });
  return messages;
}

/**
 * 募集を始めたお知らせ（§5.5）。募集メッセージへの返信として、募集メッセージとは別に投稿する。
 * 参加者をロールで決めた調整はそのロールを、それ以外は @everyone をメンションする（security-design E-3）。
 * Bot に「@everyone、@here、全てのロールにメンション」の権限がないサーバーでは、@everyone は文字だけが出て通知されない
 */
export function buildAnnounceMessage(poll: Pick<PollRow, "title" | "target_type" | "target_id">, pollMessageId: string) {
  const text = `**${escapeMarkdown(poll.title ?? "日程調整")}** の募集を始めました。募集メッセージの［回答する］から入力できます。`;
  return withPollMention(poll, text, pollMessageId);
}

/**
 * 予定のリマインド（§5.7）。日付で書く。時刻のある予定は Discord のタイムスタンプ記法（見る人のタイムゾーンで日付と時刻を表示）、
 * 終日の予定は調整のタイムゾーンでの日付（例: 11/7(土)）。メンションは公開時のお知らせと同じ。
 * 募集メッセージがあれば、その返信にしてリンクも添える
 */
export function buildDayReminderMessage(
  poll: Pick<PollRow, "title" | "target_type" | "target_id" | "guild_id" | "channel_id" | "message_id">,
  when: { startAt: number; allDay: boolean; timezone: string },
) {
  const link = poll.message_id ? `\n${messageLink(poll.guild_id, poll.channel_id, poll.message_id)}` : "";
  const time = when.allDay ? `${formatDate(when.startAt, when.timezone)} です（終日）。` : `<t:${when.startAt}:f> からです。`;
  const text = `**${escapeMarkdown(poll.title ?? "日程調整")}** は ${time}${link}`;
  return withPollMention(poll, text, poll.message_id);
}

/**
 * 確定のお知らせ（§4.3）。いま確定している日時と、前回のお知らせのあとに取り消した日時をまとめて書く。
 * mention のときは、公開時のお知らせ（§5.5）と同じく、参加者をロールで決めた調整はそのロールを、それ以外は @everyone をメンションする
 */
export function buildFixedMessage(
  poll: Pick<PollRow, "title" | "target_type" | "target_id">,
  fixed: readonly { when: string; note: string | null }[],
  cancelled: readonly string[],
  mention: boolean,
) {
  const lines = [`**${escapeMarkdown(poll.title ?? "日程調整")}** の日程のお知らせ`];
  if (fixed.length) lines.push("確定した日時:", ...fixed.map((f) => `・${f.when}${f.note ? `（${f.note}）` : ""}`));
  else lines.push("確定している日時はありません。");
  if (cancelled.length) lines.push("確定を取り消した日時:", ...cancelled.map((w) => `・~~${w}~~`));
  const text = lines.join("\n");
  return mention ? withPollMention(poll, text, null) : { content: text, allowed_mentions: { parse: [] as string[] } };
}

/** 参加者をロールで決めた調整はそのロールを、それ以外は @everyone を、本文の最後の行でメンションする（security-design E-3） */
function withPollMention(poll: Pick<PollRow, "target_type" | "target_id">, text: string, replyTo: string | null) {
  const reply = replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {};
  const roleId = poll.target_type === "role" && poll.target_id && /^\d{17,20}$/.test(poll.target_id) ? poll.target_id : null;
  if (roleId) return { content: `${text}\n<@&${roleId}>`, allowed_mentions: { parse: [] as string[], roles: [roleId], replied_user: false }, ...reply };
  return { content: `${text}\n@everyone`, allowed_mentions: { parse: ["everyone"], replied_user: false }, ...reply };
}

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
