// Worker と Web 画面で共有する型・定数・集計ロジック
// （docs/design.md §6.9 回答の選択肢、§6.9.3 集計と最有力候補）

export type ChoiceKind = "ok" | "maybe" | "ng";
export type ChoiceColor = "green" | "teal" | "yellow" | "orange" | "red" | "gray";
export type PollStatus = "draft" | "open" | "closed" | "fixed" | "cancelled";
export type Role = "organizer" | "participant";
export type Purpose = "edit" | "answer" | "view";

export const LIMITS = {
  titleMax: 100,
  descriptionMax: 1000,
  commentMax: 100,
  slotsMax: 30,
  participantsMax: 100,
  choicesMin: 2,
  choicesMax: 5,
  choiceSymbolGraphemesMax: 2,
  choiceLabelMax: 10,
  choiceScoreMax: 10,
  displayNameMax: 64,
  bodyBytesMax: 32 * 1024,
} as const;

export const CHOICE_COLORS: readonly ChoiceColor[] = ["green", "teal", "yellow", "orange", "red", "gray"];
export const CHOICE_KINDS: readonly ChoiceKind[] = ["ok", "maybe", "ng"];

export const KIND_LABEL: Record<ChoiceKind, string> = {
  ok: "参加できる",
  maybe: "未定",
  ng: "参加できない",
};

export const DEFAULT_SCORE: Record<ChoiceKind, number> = { ok: 2, maybe: 1, ng: 0 };
export const DEFAULT_COLOR: Record<ChoiceKind, ChoiceColor> = { ok: "green", maybe: "yellow", ng: "red" };

export interface ChoiceInput {
  symbol: string;
  label: string;
  kind: ChoiceKind;
  score: number;
  color: ChoiceColor;
}

export interface ChoiceTemplate {
  id: string;
  name: string;
  choices: ChoiceInput[];
}

/** ひな形（§6.9.2）。先頭が既定 */
export const CHOICE_TEMPLATES: readonly ChoiceTemplate[] = [
  {
    id: "standard",
    name: "標準",
    choices: [
      { symbol: "○", label: "参加", kind: "ok", score: 2, color: "green" },
      { symbol: "△", label: "未定", kind: "maybe", score: 1, color: "yellow" },
      { symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ],
  },
  {
    id: "binary",
    name: "2 択",
    choices: [
      { symbol: "○", label: "参加", kind: "ok", score: 1, color: "green" },
      { symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ],
  },
  {
    id: "four",
    name: "4 段階",
    choices: [
      { symbol: "◎", label: "ぜひ参加", kind: "ok", score: 3, color: "green" },
      { symbol: "○", label: "参加できる", kind: "ok", score: 2, color: "teal" },
      { symbol: "△", label: "未定", kind: "maybe", score: 1, color: "yellow" },
      { symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ],
  },
  {
    id: "time",
    name: "時間の条件つき",
    choices: [
      { symbol: "○", label: "参加", kind: "ok", score: 3, color: "green" },
      { symbol: "遅", label: "遅れて参加", kind: "maybe", score: 2, color: "teal" },
      { symbol: "早", label: "途中で抜ける", kind: "maybe", score: 2, color: "orange" },
      { symbol: "×", label: "不可", kind: "ng", score: 0, color: "red" },
    ],
  },
];

export interface ChoiceLike {
  id: string;
  kind: ChoiceKind;
  score: number;
}

export interface AnswerLike {
  slotId: string;
  userId: string;
  choiceId: string;
}

export interface SlotLike {
  id: string;
  startAt: number;
}

export interface SlotTally {
  slotId: string;
  /** 選択肢 ID → 人数 */
  byChoice: Record<string, number>;
  ok: number;
  maybe: number;
  ng: number;
  answered: number;
  score: number;
}

/** 候補ごとの集計（未回答は数えない） */
export function tally(slots: readonly SlotLike[], choices: readonly ChoiceLike[], answers: readonly AnswerLike[]): Map<string, SlotTally> {
  const choiceById = new Map(choices.map((c) => [c.id, c]));
  const result = new Map<string, SlotTally>();
  for (const s of slots) {
    const byChoice: Record<string, number> = {};
    for (const c of choices) byChoice[c.id] = 0;
    result.set(s.id, { slotId: s.id, byChoice, ok: 0, maybe: 0, ng: 0, answered: 0, score: 0 });
  }
  for (const a of answers) {
    const t = result.get(a.slotId);
    const c = choiceById.get(a.choiceId);
    if (!t || !c) continue;
    t.byChoice[c.id] = (t.byChoice[c.id] ?? 0) + 1;
    t[c.kind] += 1;
    t.answered += 1;
    t.score += c.score;
  }
  return result;
}

/**
 * 最有力候補（★）の判定（§6.9.3）
 * 1. ng が少ない 2. 点数の合計が大きい 3. ok が多い 4. 日時が早い
 * 誰も回答していなければ null
 */
export function bestSlotId(slots: readonly SlotLike[], tallies: Map<string, SlotTally>): string | null {
  let best: { slot: SlotLike; t: SlotTally } | null = null;
  for (const slot of slots) {
    const t = tallies.get(slot.id);
    if (!t || t.answered === 0) continue;
    if (!best || compareSlots(slot, t, best.slot, best.t) < 0) best = { slot, t };
  }
  return best ? best.slot.id : null;
}

/** 並び順「点数の高い順」用の比較（負なら a が上） */
export function compareSlots(a: SlotLike, ta: SlotTally, b: SlotLike, tb: SlotTally): number {
  if (ta.ng !== tb.ng) return ta.ng - tb.ng;
  if (ta.score !== tb.score) return tb.score - ta.score;
  if (ta.ok !== tb.ok) return tb.ok - ta.ok;
  return a.startAt - b.startAt;
}

/** 締切を過ぎたかを含めた実際の状態（Cron の状態変更を待たない） */
export function effectiveStatus(status: PollStatus, deadlineAt: number | null, now: number): PollStatus {
  if (status === "open" && deadlineAt !== null && deadlineAt <= now) return "closed";
  return status;
}

/** 回答を入力・変更できる状態か（§4.2） */
export function canAnswer(status: PollStatus): boolean {
  return status === "open" || status === "closed" || status === "fixed";
}
