// Web API の入力スキーマ（未知のキーは拒否する。docs/design.md §8.1）
import * as v from "valibot";
import { CHOICE_COLORS, CHOICE_KINDS, LIMITS } from "../shared/model";
import { charLength, graphemeLength, hasControlChars, hasControlCharsExceptNewline, isSafeChoiceText } from "../shared/text";

const id = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));
const snowflake = v.pipe(v.string(), v.regex(/^\d{17,20}$/));
const epoch = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4102444800));

const singleLine = (max: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.check((s) => charLength(s) >= 1 && charLength(s) <= max, `1〜${max} 文字で入力してください`),
    v.check((s) => !hasControlChars(s), "使えない文字が含まれています"),
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
        v.check((s) => charLength(s) <= LIMITS.descriptionMax, `${LIMITS.descriptionMax} 文字以内で入力してください`),
        v.check((s) => !hasControlCharsExceptNewline(s), "使えない文字が含まれています"),
      ),
    ),
  ),
  deadlineAt: v.optional(epoch),
  timezone: v.optional(v.pipe(v.string(), v.maxLength(64))),
  timezoneAuto: v.optional(v.boolean()),
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
    v.maxLength(LIMITS.slotsMax, `候補は ${LIMITS.slotsMax} 件までです`),
  ),
});

const choiceText = (maxGraphemes: number, maxChars: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.check((s) => graphemeLength(s) >= 1 && graphemeLength(s) <= maxGraphemes && charLength(s) <= maxChars, "長さが正しくありません"),
    v.check(isSafeChoiceText, "使えない文字が含まれています"),
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
    v.minLength(LIMITS.choicesMin, `選択肢は ${LIMITS.choicesMin} 個以上にしてください`),
    v.maxLength(LIMITS.choicesMax, `選択肢は ${LIMITS.choicesMax} 個までです`),
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
      v.check((s) => charLength(s) <= LIMITS.commentMax, `${LIMITS.commentMax} 文字以内で入力してください`),
      v.check((s) => !hasControlChars(s), "使えない文字が含まれています"),
    ),
  ),
});

/** 公開。mentionEveryone は、ロールのない調整で @everyone に知らせるか（主催者がチェックしたときだけ true。§5.5） */
export const PublishBody = v.strictObject({ mentionEveryone: v.optional(v.boolean()) });

export const FixBody = v.strictObject({
  slotId: id,
  mention: v.boolean(),
  event: v.nullable(
    v.strictObject({
      type: v.picklist(["voice", "external"]),
      channelId: v.nullable(snowflake),
      location: v.nullable(singleLine(100)),
    }),
  ),
});
