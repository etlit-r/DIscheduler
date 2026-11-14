// Web API の入力スキーマ（未知のキーは拒否する。docs/design.md §8.1）
import * as v from "valibot";
import { CHOICE_COLORS, CHOICE_KINDS, LIMITS } from "../shared/model";
import { vmsg } from "../shared/i18n";
import { charLength, graphemeLength, hasControlChars, hasControlCharsExceptNewline, isSafeChoiceText } from "../shared/text";

const id = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));
const snowflake = v.pipe(v.string(), v.regex(/^\d{17,20}$/));
const epoch = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4102444800));

const singleLine = (max: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.check((s) => charLength(s) >= 1 && charLength(s) <= max, vmsg(`1〜${max} 文字で入力してください`, `Enter 1 to ${max} characters`)),
    v.check((s) => !hasControlChars(s), vmsg("使えない文字が含まれています", "Contains characters that can't be used")),
  );

export const SessionBody = v.strictObject({ token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)) });

/** 主催者の調整一覧から調整を開く（docs/design.md §6.11） */
export const OpenPollBody = v.strictObject({ to: v.picklist(["edit", "summary"]) });

export const PatchPollBody = v.strictObject({
  updatedAt: v.optional(epoch),
  title: v.optional(singleLine(LIMITS.titleMax)),
  description: v.optional(
    v.nullable(
      v.pipe(
        v.string(),
        v.check((s) => charLength(s) <= LIMITS.descriptionMax, vmsg(`${LIMITS.descriptionMax} 文字以内で入力してください`, `Enter up to ${LIMITS.descriptionMax} characters`)),
        v.check((s) => !hasControlCharsExceptNewline(s), vmsg("使えない文字が含まれています", "Contains characters that can't be used")),
      ),
    ),
  ),
  deadlineAt: v.optional(epoch),
  timezone: v.optional(v.pipe(v.string(), v.maxLength(64))),
  timezoneAuto: v.optional(v.boolean()),
  // 予定のリマインド（§5.7）: 当日（0）か前日（1）の何時（0〜23）に送るか
  remindDayOffset: v.optional(v.picklist([0, 1])),
  remindHour: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(23))),
  members: v.optional(v.picklist(["auto", "manual"])),
  roleId: v.optional(v.nullable(snowflake)),
  joinPolicy: v.optional(v.picklist(["closed", "open"])),
});

export const SlotsBody = v.strictObject({
  updatedAt: v.optional(epoch),
  slots: v.pipe(
    v.array(
      v.strictObject({
        id: v.nullable(id),
        startAt: epoch,
        endAt: v.nullable(epoch),
        allDay: v.boolean(),
      }),
    ),
    v.maxLength(LIMITS.slotsMax, vmsg(`候補は ${LIMITS.slotsMax} 件までです`, `You can add up to ${LIMITS.slotsMax} date options`)),
  ),
});

const choiceText = (maxGraphemes: number, maxChars: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.check((s) => graphemeLength(s) >= 1 && graphemeLength(s) <= maxGraphemes && charLength(s) <= maxChars, vmsg("長さが正しくありません", "The length is not valid")),
    v.check(isSafeChoiceText, vmsg("使えない文字が含まれています", "Contains characters that can't be used")),
  );

export const ChoicesBody = v.strictObject({
  choicesVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  choices: v.pipe(
    v.array(
      v.strictObject({
        id: v.nullable(id),
        symbol: choiceText(LIMITS.choiceSymbolGraphemesMax, 8),
        label: choiceText(LIMITS.choiceLabelMax, LIMITS.choiceLabelMax),
        kind: v.picklist(CHOICE_KINDS as ["ok", "maybe", "ng"]),
        score: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LIMITS.choiceScoreMax)),
        color: v.picklist(CHOICE_COLORS as ["green", "teal", "yellow", "orange", "red", "gray"]),
      }),
    ),
    v.minLength(LIMITS.choicesMin, vmsg(`選択肢は ${LIMITS.choicesMin} 個以上にしてください`, `Add at least ${LIMITS.choicesMin} answer choices`)),
    v.maxLength(LIMITS.choicesMax, vmsg(`選択肢は ${LIMITS.choicesMax} 個までです`, `You can add up to ${LIMITS.choicesMax} answer choices`)),
  ),
  reassign: v.pipe(v.array(v.strictObject({ from: id, to: id })), v.maxLength(LIMITS.choicesMax)),
});

export const ParticipantsBody = v.strictObject({
  add: v.pipe(v.array(snowflake), v.maxLength(25)),
  remove: v.pipe(v.array(snowflake), v.maxLength(LIMITS.participantsMax)),
});

export const AnswersBody = v.strictObject({
  choicesVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  answers: v.pipe(v.array(v.strictObject({ slotId: id, choiceId: id })), v.maxLength(LIMITS.slotsMax)),
  comment: v.nullable(
    v.pipe(
      v.string(),
      v.trim(),
      v.check((s) => charLength(s) <= LIMITS.commentMax, vmsg(`${LIMITS.commentMax} 文字以内で入力してください`, `Enter up to ${LIMITS.commentMax} characters`)),
      v.check((s) => !hasControlChars(s), vmsg("使えない文字が含まれています", "Contains characters that can't be used")),
    ),
  ),
});

export const FixBody = v.strictObject({
  slotId: id,
  event: v.nullable(
    v.strictObject({
      type: v.picklist(["voice", "external"]),
      channelId: v.nullable(snowflake),
      location: v.nullable(singleLine(100)),
    }),
  ),
});

/** 確定のお知らせ（確定日と取り消しをまとめて投稿する。§4.3） */
export const AnnounceBody = v.strictObject({
  mention: v.boolean(),
});
