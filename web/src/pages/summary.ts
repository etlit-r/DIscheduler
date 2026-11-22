// S4: 集計・確定（docs/design.md §6.5）
import { loadPoll, request, type PollData } from "../lib/api";
import { choiceMark, dateTimeText, donationLine, memberMatrix, mountViewerTzSwitch, rememberDonation, showError, slotText, STATUS_LABEL, statusBanner, syncPanel, viewerTimeZone, errorText } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { bestSlotIds, compareSlots, reminderAt, tally, UNANSWERED } from "../../../src/shared/model";
import { tr } from "../lib/i18n";

/** 確定・確定の取り消しのあと、次に押せるまでの時間 */
const FIX_COOLDOWN_MS = 3000;

export async function summaryPage(pollId: string): Promise<void> {
  let data: PollData;
  try {
    data = await loadPoll(pollId);
  } catch (e) {
    return showError(e, "summary");
  }
  rememberDonation(data.donationUrl);
  let sortByScore = false;
  // 描き直しても［メンバー別に表示］の開いた状態を保つ
  // ［メンバー別に表示］は最初から開いておく
  let matrixOpen = true;
  /** 確定・確定の取り消しの処理中（と、そのあとの少しのあいだ）。両方の表のボタンを押せなくする */
  let fixBusy = false;
  /** 確定のお知らせの欄で開いている入力欄（お知らせ・イベントの登録。描き直しても開いたままにする） */
  let announceMode: AnnounceMode = null;
  let announceDraft: AnnounceDraft = {};
  /** 確定のお知らせを投稿したあとに、運営の支援のお願いを画面のいちばん下に出すか */
  let showSupport = false;
  let message: HTMLElement | null = null;

  const reload = async (msg?: HTMLElement) => {
    try {
      data = await loadPoll(pollId);
      message = msg ?? null;
      draw();
    } catch (e) {
      showError(e, "summary");
    }
  };
  mountViewerTzSwitch(() => draw());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reload(message ?? undefined);
  });

  function draw(): void {
    const d = data;
    const tz = viewerTimeZone();
    const isOrganizer = d.me.role === "organizer";
    setTitle(d.poll.title ?? tr("集計", "Results"));
    const slots = d.slots.map((s) => ({ id: s.id, startAt: s.startAt, fixed: s.fixedAt !== null }));
    const t = tally(slots, d.choices, d.answers);
    const best = bestSlotIds(slots, t);
    const order = [...d.slots];
    if (sortByScore) order.sort((a, b) => compareSlots(a, t.get(a.id)!, b, t.get(b.id)!));
    const answered = new Set(d.answers.map((a) => a.userId));
    const nameOf = new Map(d.participants.map((p) => [p.userId, p.displayName]));
    const choiceById = new Map(d.choices.map((c) => [c.id, c]));
    const symbolOf = (id: string) => (id === UNANSWERED ? tr("未回答", "No answer") : (choiceById.get(id)?.symbol ?? "?"));
    const canFix = isOrganizer && (d.poll.status === "open" || d.poll.status === "closed" || d.poll.status === "fixed");

    // 候補ごとの集計表
    const head = h("tr", {}, h("th", { scope: "col" }, tr("候補", "Date option")), ...d.choices.map((c) => h("th", { scope: "col" }, choiceMark(c))), h("th", { scope: "col" }, tr("未回答", "No answer")));
    const body = h("tbody");
    for (const s of order) {
      const tt = t.get(s.id)!;
      const st = slotText(s, d.poll.timezone, tz);
      const isFixed = s.fixedAt !== null;
      const changed = isFixed
        ? d.answers.filter((a) => a.slotId === s.id && a.prevChoiceId !== null && a.prevChoiceId !== a.choiceId)
        : [];
      body.appendChild(
        h(
          "tr",
          { class: isFixed ? "is-fixed" : best.has(s.id) ? "is-best" : "" },
          h(
            "th",
            { scope: "row" },
            isFixed ? h("span", { class: "badge badge-fixed" }, tr("確定", "Confirmed")) : best.has(s.id) ? h("span", { class: "star", aria: { label: tr("最有力候補", "Best option") } }, "★ ") : null,
            st.main,
            st.sub ? h("span", { class: "slot-sub" }, st.sub) : null,
            isFixed ? h("span", { class: "slot-sub" }, reminderLabel(d, s, tz)) : null,
            changed.length
              ? h(
                  "span",
                  { class: "changed-note" },
                  tr("確定後に変更: ", "Changed after confirmation: "),
                  changed
                    .map((a) => tr(`${nameOf.get(a.userId) ?? "?"}（${symbolOf(a.prevChoiceId!)}→${symbolOf(a.choiceId)}、${dateTimeText(a.updatedAt, tz)}）`, `${nameOf.get(a.userId) ?? "?"} (${symbolOf(a.prevChoiceId!)}→${symbolOf(a.choiceId)}, ${dateTimeText(a.updatedAt, tz)})`))
                    .join(tr("、", ", ")),
                )
              : null,
            // 確定の操作は日時の下に置く（狭い画面でも横にスクロールせずに押せるように）
            canFix
              ? h(
                  "div",
                  { class: "fix-actions" },
                  isFixed ? unfixButton(d, s, st.main) : fixButton(d, s, st.main),
                )
              : null,
          ),
          ...d.choices.map((c) => h("td", { class: "num" }, String(tt.byChoice[c.id] ?? 0))),
          h("td", { class: "num" }, String(d.participants.length - tt.answered)),
        ),
      );
    }
    const table = h("div", { class: "table-wrap" }, h("table", { class: "data tally-table" }, h("thead", {}, head), body));

    // メンバー別の表
    // 主催者は、日時の見出しからも確定・確定の取り消しができる（候補ごとの表と同じ操作）
    const matrix = memberMatrix(
      d,
      tz,
      tr("メンバー別に表示", "Show by member"),
      matrixOpen,
      (o) => (matrixOpen = o),
      canFix ? (s, label) => (s.fixedAt !== null ? unfixButton(d, s, label) : fixButton(d, s, label)) : undefined,
    );

    const unanswered = d.participants.filter((p) => !answered.has(p.userId));

    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        h("h1", {}, d.poll.title ?? tr("日程調整", "Scheduling poll"), " ", h("span", { class: "tag tag-optional" }, STATUS_LABEL[d.poll.status] ?? "")),
        h("p", { class: "meta" }, tr(`回答 ${answered.size}/${d.participants.length} 名`, `Answered ${answered.size}/${d.participants.length}`), d.poll.deadlineAt ? h("span", {}, h("span", { class: "sep" }, "／"), tr(`締切 ${dateTimeText(d.poll.deadlineAt, tz)}`, `Deadline ${dateTimeText(d.poll.deadlineAt, tz)}`)) : null),
        d.poll.description ? h("p", { class: "description" }, d.poll.description) : null,
        statusBanner(d),
        message,
        h(
          "div",
          { class: "row" },
          d.me.isParticipant && d.poll.status !== "draft" ? h("a", { class: "btn btn-primary", href: `/p/${pollId}/answer` }, tr("回答する・変更する", "Answer or change your answer")) : null,
          isOrganizer ? h("a", { class: "btn btn-secondary", href: `/p/${pollId}/edit` }, tr("調整を編集する", "Edit the poll")) : null,
          h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => void reload() }, tr("↻ 更新", "↻ Refresh")),
        ),
        isOrganizer
          ? announcePanel(d, announceMode, announceDraft, (m) => {
              announceMode = m;
              // 閉じたら入力中の内容は捨てる（次に開いたときは既定値から）
              if (!m) announceDraft = {};
              draw();
            }, (m, announced) => {
              // お知らせを投稿できたら、運営の支援のお願いを画面のいちばん下に出す
              if (announced) showSupport = true;
              void reload(m);
            })
          : null,
        h(
          "div",
          { class: "row" },
          h("span", { class: "muted small" }, tr("並び順:", "Sort:")),
          h("button", { type: "button", class: `btn btn-small ${sortByScore ? "btn-secondary" : "btn-primary"}`, aria: { pressed: String(!sortByScore) }, onClick: () => { sortByScore = false; draw(); } }, tr("日時順", "By date")),
          h("button", { type: "button", class: `btn btn-small ${sortByScore ? "btn-primary" : "btn-secondary"}`, aria: { pressed: String(sortByScore) }, onClick: () => { sortByScore = true; draw(); } }, tr("点数の高い順", "By score")),
        ),
        table,
        h("p", { class: "muted small" }, tr("★ は最有力候補です（「参加できない」が最も少なく、点数の合計が最も大きい候補）。同じ成績の候補が 4 件以上あって絞れないときは付けません。", "★ marks the best option (the fewest \"not available\" answers and the highest total score). It isn't shown when 4 or more options are tied.")),
        matrix,
        h(
          "section",
          { class: "card" },
          h("h2", { class: "card-title" }, tr(`未回答（${unanswered.length} 名）`, `No answer yet (${unanswered.length})`)),
          h("p", {}, unanswered.length ? unanswered.map((p) => p.displayName).join(tr("、", ", ")) : tr("全員が回答しました。", "Everyone has answered.")),
          isOrganizer && unanswered.length && d.poll.status !== "draft" && d.poll.status !== "fixed" ? remindButton(d, (m) => void reload(m)) : null,
        ),
        syncPanel(d, () => void reload(notice("ok", tr("募集メッセージを更新しました。", "The poll message was updated.")))),
        // 運営の支援のお願いは、操作の邪魔にならないよう画面のいちばん下に出す
        showSupport ? donationLine(d.donationUrl) : null,
      ),
    );
  }

  /**
   * 確定・確定の取り消しを続けて押せないようにする（押したら終わるまで、終わってからも少しのあいだ、両方の表のボタンを押せなくする）。
   * サーバーでも 1 つの調整につき 10 秒に 5 回までに制限している（POST /fix・DELETE /fix）
   */
  async function runFixOp(op: () => Promise<HTMLElement>): Promise<void> {
    if (fixBusy) return;
    fixBusy = true;
    draw();
    let m: HTMLElement;
    try {
      m = await op();
    } finally {
      setTimeout(() => {
        fixBusy = false;
        draw();
      }, FIX_COOLDOWN_MS);
    }
    await reload(m);
  }

  /** 確定のボタン（候補ごとの表とメンバー別の表で同じもの）。押すと確認なしで確定する */
  function fixButton(d: PollData, s: PollData["slots"][number], label: string): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-small",
        disabled: fixBusy,
        aria: { label: tr(`${label} で確定`, `Confirm ${label}`) },
        onClick: () =>
          void runFixOp(async () => {
            try {
              const r = await request<{ warnings: string[] }>("POST", `/api/polls/${d.poll.id}/fix`, { slotId: s.id });
              return notice(r.warnings.length ? "warn" : "ok", tr(`${label} を確定しました。チャンネルへのお知らせと Discord イベントの登録は［確定をお知らせする］から行えます。`, `Confirmed ${label}. You can post the announcement and create Discord events with [Announce the dates].`), ...r.warnings.map((w) => ` ${w}`));
            } catch (e) {
              return notice("error", errorText(e, "summary", tr("確定できませんでした。", "Couldn't confirm.")));
            }
          }),
      },
      tr("確定", "Confirm"),
    );
  }

  function remindButton(d: PollData, done: (m: HTMLElement) => void): HTMLElement {
    const btn = h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-small",
        onClick: async () => {
          if (!confirm(tr("未回答の人にメンション付きでリマインドを投稿します。よろしいですか？（1 時間に 5 回まで）", "Post a reminder that mentions everyone who hasn't answered? (Up to 5 per hour)"))) return;
          btn.disabled = true;
          try {
            const r = await request<{ count: number }>("POST", `/api/polls/${d.poll.id}/remind`, {});
            done(notice("ok", tr(`${r.count} 名にリマインドしました。`, `Reminded ${r.count} people.`)));
          } catch (e) {
            done(notice("error", errorText(e, "summary", tr("リマインドできませんでした。", "Couldn't send the reminder."))));
          }
        },
      },
      tr("未回答者にリマインド", "Remind people who haven't answered"),
    );
    return btn;
  }

  // 確定を取り消す（主催者）。Discord イベントも消える。チャンネルへのお知らせは［確定をお知らせする］から（§4.3）
  function unfixButton(d: PollData, s: PollData["slots"][number], label: string): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-small",
        disabled: fixBusy,
        // どの日時の取り消しかを読み上げでも分かるようにする（確定した候補が複数あると、同じ文字のボタンが並ぶため）
        aria: { label: tr(`${label} の確定を取り消す`, `Cancel confirmation of ${label}`) },
        onClick: () => {
          // 取り消すと登録した Discord イベントも消えるので、取り消しだけは確かめる
          const ev = s.hasEvent ? tr("登録した Discord イベントも削除されます。", "The Discord event will also be deleted.") : "";
          if (!confirm(tr(`${label} の確定を取り消します。${ev}よろしいですか？`, `Cancel the confirmation of ${label}? ${ev}`.trim()))) return;
          void runFixOp(async () => {
            try {
              const r = await request<{ warnings: string[] }>("DELETE", `/api/polls/${d.poll.id}/fix/${s.id}`);
              return notice(r.warnings.length ? "warn" : "ok", tr(`${label} の確定を取り消しました。チャンネルへのお知らせは［確定をお知らせする］から投稿できます。`, `Cancelled the confirmation of ${label}. You can post an announcement to the channel with [Announce the dates].`), ...r.warnings.map((w) => ` ${w}`));
            } catch (e) {
              return notice("error", errorText(e, "summary", tr("確定を取り消せませんでした。", "Couldn't cancel the confirmation.")));
            }
          });
        },
      },
      tr("確定を取り消す", "Cancel confirmation"),
    );
  }


  draw();
}

/** 確定した日時のリマインドの予定（§5.7） */
function reminderLabel(d: PollData, s: PollData["slots"][number], tz: string): string {
  const at = reminderAt(s, d.poll.timezone, d.poll.remindDayOffset, d.poll.remindHour);
  if (at !== null) return tr(`リマインド: ${dateTimeText(at, tz)}`, `Reminder: ${dateTimeText(at, tz)}`);
  // 既定（当日の 17 時）だと朝や昼の予定には送られないので、主催者には変え方を添える
  return d.me.role === "organizer" ? tr("リマインド: なし（予定が始まったあとになるため。作成画面で「予定の前日」などに変えられます）", "Reminder: none (it would be after the event starts. You can change it to \"the day before\" on the edit page)") : tr("リマインド: なし", "Reminder: none");
}

/**
 * Discord イベントの入力欄（確定のお知らせのときに出す。§4.3）。
 * 確定したすべての日時に、同じ内容のイベントを日時だけ変えて登録する
 */
export interface AnnounceDraft {
  mention?: boolean;
  useEvent?: boolean;
  type?: "voice" | "external";
  channelId?: string;
  location?: string;
}

function eventFields(d: PollData, draft: AnnounceDraft, withCheckbox = true): { element: HTMLElement; value: () => { type: "voice" | "external"; channelId: string | null; location: string } | null } {
  // 登録済みのイベントがあれば、最初からチェックを入れておく（この内容に更新する）
  const useEvent = h("input", { type: "checkbox", id: "ev-use", checked: draft.useEvent ?? d.slots.some((s) => s.fixedAt !== null && s.hasEvent) });
  // サーバーの既定値（§5.3.1）でボイスチャンネルを決めていれば、「ボイスチャンネル」を最初から選ぶ
  const defaultChannel = draft.channelId ?? d.defaultEventChannelId;
  const voiceFirst = draft.type ? draft.type === "voice" : !!defaultChannel;
  const typeVoice = h("input", { type: "radio", name: "ev-type", id: "ev-voice", value: "voice", checked: voiceFirst });
  const typeExternal = h("input", { type: "radio", name: "ev-type", id: "ev-external", value: "external", checked: !voiceFirst });
  const voiceSel = h("select", { id: "ev-channel" }, h("option", { value: "" }, tr("読み込み中…", "Loading…")));
  // 最初に入れておく場所は、サーバーの既定値（§5.3.1）。決めていなければ「Discord」
  const location = h("input", { type: "text", id: "ev-location", maxLength: 100, value: draft.location ?? d.defaultEventLocation ?? "Discord", autocomplete: "off" });
  // 入力中の内容を覚える（画面を描き直しても消えないように）
  useEvent.addEventListener("change", () => (draft.useEvent = useEvent.checked));
  typeVoice.addEventListener("change", () => (draft.type = "voice"));
  typeExternal.addEventListener("change", () => (draft.type = "external"));
  voiceSel.addEventListener("change", () => (draft.channelId = voiceSel.value));
  location.addEventListener("input", () => (draft.location = location.value));
  let voiceLoaded = false;
  const loadVoice = async () => {
    if (voiceLoaded) return;
    voiceLoaded = true;
    try {
      const r = await request<{ channels: { id: string; name: string }[] }>("GET", `/api/polls/${d.poll.id}/voice-channels`);
      render(voiceSel, h("option", { value: "" }, tr("選んでください", "Choose")), ...r.channels.map((c) => h("option", { value: c.id }, c.name)));
      if (defaultChannel && r.channels.some((c) => c.id === defaultChannel)) voiceSel.value = defaultChannel;
      // 既定のチャンネルが消えていたら、「場所を入力」に戻す（選ばないままだとイベントを登録できないため）
      else if (defaultChannel && typeVoice.checked) typeExternal.checked = true;
    } catch {
      render(voiceSel, h("option", { value: "" }, tr("読み込めませんでした", "Couldn't load")));
      if (defaultChannel && typeVoice.checked) typeExternal.checked = true;
    }
  };
  typeVoice.addEventListener("change", () => void loadVoice());
  if (voiceFirst || defaultChannel) void loadVoice();
  const fixedCount = d.slots.filter((s) => s.fixedAt !== null).length;
  const element = h(
    "div",
    { class: "event-fields" },
    withCheckbox ? h("div", { class: "field-inline field-check" }, useEvent, h("label", { for: "ev-use" }, tr("Discord イベントとして登録する", "Create Discord events"))) : null,
    h(
      "fieldset",
      { class: "sub-fields" },
      h("legend", {}, tr("イベントの場所", "Event location")),
      h("div", { class: "field-inline" }, typeExternal, h("label", { for: "ev-external" }, tr("場所を入力", "Enter a location")), location),
      h("div", { class: "field-inline" }, typeVoice, h("label", { for: "ev-voice" }, tr("ボイスチャンネル", "Voice channel")), voiceSel),
    ),
    h(
      "p",
      { class: "muted small" },
      tr(
        `確定した日時（${fixedCount} 件）それぞれに、同じ内容（調整のタイトル・説明・場所）のイベントを登録します。登録済みのイベントは、この内容に更新します。開始日時が過ぎた日時には登録しません。`,
        `A Discord event with the same details (poll title, description and location) is created for each confirmed date (${fixedCount}). Events already created are updated to these details. Dates that have already started are skipped.`,
      ),
    ),
  );
  return {
    element,
    value: () =>
      (useEvent.checked || !withCheckbox) && fixedCount
        ? { type: typeVoice.checked ? "voice" : "external", channelId: typeVoice.checked ? voiceSel.value || null : null, location: location.value.trim() || "Discord" }
        : null,
  };
}

/** 確定のお知らせの欄で開いている入力欄（お知らせ・イベントの登録・閉じている） */
export type AnnounceMode = "announce" | "event" | null;

/**
 * 確定のお知らせの欄（主催者）。
 * - ［確定をお知らせする］: メンションと Discord イベントの入力欄を出し、［お知らせを投稿する］で投稿する
 * - ［Discord イベントに登録する］: Discord イベントの入力欄だけを出し、お知らせはせずにイベントを登録する
 * mode・setMode で、描き直しても入力欄を開いたままにする
 */
function announcePanel(d: PollData, openMode: AnnounceMode, draft: AnnounceDraft, setMode: (mode: AnnounceMode) => void, done: (m: HTMLElement, announced?: boolean) => void): HTMLElement | null {
  const tz = viewerTimeZone();
  const fixed = d.slots.filter((s) => s.fixedAt !== null);
  // イベントの登録の入力欄を開いたまま確定日がなくなったら、閉じた状態に戻す（登録するものがないため）
  const mode = openMode === "event" && !fixed.length ? null : openMode;
  const cancelled = d.slots.filter((s) => s.fixedAt === null && s.announced);
  if (!fixed.length && !cancelled.length) return null;
  const newly = fixed.filter((s) => !s.announced).length;
  const pending = newly + cancelled.length;
  const list = (slots: typeof d.slots) => slots.map((s) => slotText(s, d.poll.timezone, tz).main).join(tr("、", ", "));
  const summary = h(
    "dl",
    { class: "kv" },
    h("dt", {}, tr("確定した日時", "Confirmed dates")),
    h("dd", {}, fixed.length ? list(fixed) : tr("なし", "None")),
    cancelled.length ? h("dt", {}, tr("取り消した日時", "Cancelled dates")) : null,
    cancelled.length ? h("dd", {}, list(cancelled)) : null,
    h("dt", {}, tr("まだお知らせしていない変更", "Changes not yet announced")),
    h("dd", {}, pending ? tr(`あり（確定 ${newly} 件・取り消し ${cancelled.length} 件）`, `Yes (${newly} confirmed, ${cancelled.length} cancelled)`) : tr("なし（お知らせ済みです。もう一度投稿することもできます）", "None (already announced. You can post it again)")),
  );
  const title = h("h2", { class: "card-title" }, tr("確定のお知らせ", "Announcement"), h("span", { class: "tag tag-optional" }, tr("主催者だけに表示", "Only you (the organizer) can see this")));

  if (!mode) {
    return h(
      "section",
      { class: "card announce-panel", aria: { label: tr("確定のお知らせ", "Announcement") } },
      title,
      summary,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", id: "announce-open", class: pending ? "btn btn-primary" : "btn btn-secondary", onClick: () => setMode("announce") }, tr("確定をお知らせする", "Announce the dates")),
        fixed.length ? h("button", { type: "button", id: "events-open", class: "btn btn-secondary", onClick: () => setMode("event") }, tr("Discord イベントに登録する", "Create Discord events")) : null,
      ),
    );
  }

  if (mode === "event") {
    // お知らせはせずに、Discord イベントだけを登録する
    const ev = eventFields(d, draft, false);
    const status = h("p", { role: "status", class: "muted" });
    const submit = h(
      "button",
      {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          const value = ev.value();
          if (!value) return;
          submit.disabled = true;
          status.textContent = tr("登録しています…", "Creating…");
          try {
            const r = await request<{ warnings: string[] }>("POST", `/api/polls/${d.poll.id}/events`, { event: value });
            setMode(null);
            done(notice(r.warnings.length ? "warn" : "ok", tr("Discord イベントを登録しました。", "Created the Discord events."), ...r.warnings.map((w) => ` ${w}`)));
          } catch (e) {
            status.textContent = errorText(e, "summary", tr("Discord イベントを登録できませんでした。", "Couldn't create the Discord events."));
            submit.disabled = false;
          }
        },
      },
      tr("イベントを登録する", "Create the events"),
    );
    return h(
      "section",
      { class: "card announce-panel", aria: { label: tr("確定のお知らせ", "Announcement") } },
      title,
      summary,
      h("h3", { class: "card-subtitle" }, tr("Discord イベントに登録する", "Create Discord events")),
      h("p", { class: "muted small" }, tr("チャンネルへのお知らせはしません。", "Nothing is announced to the channel.")),
      ev.element,
      h("div", { class: "row row-end" }, h("button", { type: "button", class: "btn btn-secondary", onClick: () => setMode(null) }, tr("キャンセル", "Cancel")), submit),
      status,
    );
  }

  // 入力欄: メンションと Discord イベント
  const mention = h("input", { type: "checkbox", id: "announce-mention", checked: draft.mention ?? true });
  mention.addEventListener("change", () => (draft.mention = mention.checked));
  const ev = fixed.length ? eventFields(d, draft) : null;
  const status = h("p", { role: "status", class: "muted" });
  const post = h(
    "button",
    {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        post.disabled = true;
        status.textContent = tr("投稿しています…", "Posting…");
        try {
          const r = await request<{ warnings: string[] }>("POST", `/api/polls/${d.poll.id}/announce`, { mention: mention.checked, event: ev?.value() ?? null });
          setMode(null);
          done(notice(r.warnings.length ? "warn" : "ok", tr("確定のお知らせをチャンネルに投稿しました。", "Posted the announcement to the channel."), ...r.warnings.map((w) => ` ${w}`)), true);
        } catch (e) {
          status.textContent = errorText(e, "summary", tr("お知らせを投稿できませんでした。", "Couldn't post the announcement."));
          post.disabled = false;
        }
      },
    },
    tr("お知らせを投稿する", "Post the announcement"),
  );
  return h(
    "section",
    { class: "card announce-panel", aria: { label: tr("確定のお知らせ", "Announcement") } },
    title,
    summary,
    h("p", { class: "muted small" }, tr("確定した日時と取り消した日時を、チャンネルにまとめてお知らせします。", "The confirmed and cancelled dates are announced to the channel in one message.")),
    h("div", { class: "field-inline field-check" }, mention, h("label", { for: "announce-mention" }, d.poll.targetType === "role" ? tr("参加者のロールにメンションしてお知らせする", "Mention the participants' role in the announcement") : tr("@everyone にメンションしてお知らせする", "Mention @everyone in the announcement"))),
    ev ? ev.element : null,
    h("div", { class: "row row-end" }, h("button", { type: "button", class: "btn btn-secondary", onClick: () => setMode(null) }, tr("キャンセル", "Cancel")), post),
    status,
  );
}
