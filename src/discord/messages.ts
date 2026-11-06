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

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
