// チャンネルに投稿するメッセージの組み立て（docs/design.md §5.5, §6.6）
// 個人ごとの回答は載せず、候補ごとの「参加できる」区分の人数と回答率だけを出す。
import type { ChoiceRow, ParticipantRow, PollRow, SlotRow, AnswerRow } from "../db";
import { bestSlotId, effectiveStatus, tally } from "../shared/model";

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
  if (status === "fixed" && poll.fixed_slot_id) {
    const fixed = slots.find((s) => s.id === poll.fixed_slot_id);
    if (fixed) {
      lines.push(`**確定: ${slotLabel(fixed)}**`);
      lines.push(`確定した日時に参加できる人: ${t.get(fixed.id)?.ok ?? 0} 人（<t:${now}:f> 時点）`);
    }
  } else if (status === "closed") {
    lines.push("締切を過ぎました（回答の入力・変更はできます）");
  } else if (poll.deadline_at) {
    lines.push(`締切: <t:${poll.deadline_at}:f>（<t:${poll.deadline_at}:R>）`);
  }
  lines.push(`回答: ${answered}/${participants.length} 名`, "", `**候補**（${okLabel} の人数）`);
  for (const s of slots) {
    const mark = s.id === poll.fixed_slot_id ? "✅" : s.id === best ? "★" : "・";
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

/** ユーザーへのメンション付きのお知らせ（メンションは指定したユーザーだけに限る。security-design E-3） */
export function buildMentionMessage(text: string, userIds: string[]) {
  const ids = userIds.slice(0, 100);
  return {
    content: `${text}\n${ids.map((id) => `<@${id}>`).join(" ")}`.slice(0, 2000),
    allowed_mentions: { parse: [] as string[], users: ids },
  };
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
 * 当日のリマインド（§5.7）。メンションは公開時のお知らせと同じ。
 * 募集メッセージがあれば、その返信にしてリンクも添える
 */
export function buildDayReminderMessage(poll: Pick<PollRow, "title" | "target_type" | "target_id" | "guild_id" | "channel_id" | "message_id">, startAt: number) {
  const link = poll.message_id ? `\n${messageLink(poll.guild_id, poll.channel_id, poll.message_id)}` : "";
  const text = `**${escapeMarkdown(poll.title ?? "日程調整")}** は今日 <t:${startAt}:t> からです。${link}`;
  return withPollMention(poll, text, poll.message_id);
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
