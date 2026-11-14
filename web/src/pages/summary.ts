// S4: 集計・確定（docs/design.md §6.5）
import { loadPoll, request, type PollData } from "../lib/api";
import { choiceMark, dateTimeText, donationLine, memberMatrix, mountViewerTzSwitch, rememberDonation, showError, slotText, STATUS_LABEL, statusBanner, syncPanel, viewerTimeZone, errorText } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { bestSlotId, compareSlots, reminderAt, tally, UNANSWERED } from "../../../src/shared/model";
import { tr } from "../lib/i18n";

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
  let matrixOpen = false;
  let fixTarget: string | null = null;
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
    const slots = d.slots.map((s) => ({ id: s.id, startAt: s.startAt }));
    const t = tally(slots, d.choices, d.answers);
    const best = bestSlotId(slots, t);
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
          { class: isFixed ? "is-fixed" : s.id === best ? "is-best" : "" },
          h(
            "th",
            { scope: "row" },
            isFixed ? h("span", { class: "badge badge-fixed" }, tr("確定", "Confirmed")) : s.id === best ? h("span", { class: "star", aria: { label: tr("最有力候補", "Best option") } }, "★ ") : null,
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
                  isFixed
                    ? unfixButton(d, s, st.main, (m) => void reload(m))
                    : h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { fixTarget = s.id; draw(); } }, tr("確定", "Confirm")),
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
    const matrix = memberMatrix(d, tz, tr("メンバー別に表示", "Show by member"), matrixOpen, (o) => (matrixOpen = o));

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
        fixTarget ? fixPanel(d, fixTarget, () => { fixTarget = null; draw(); }, (m) => { fixTarget = null; void reload(m); }) : null,
        isOrganizer ? announcePanel(d, (m) => void reload(m)) : null,
        h(
          "div",
          { class: "row" },
          h("span", { class: "muted small" }, tr("並び順:", "Sort:")),
          h("button", { type: "button", class: `btn btn-small ${sortByScore ? "btn-secondary" : "btn-primary"}`, aria: { pressed: String(!sortByScore) }, onClick: () => { sortByScore = false; draw(); } }, tr("日時順", "By date")),
          h("button", { type: "button", class: `btn btn-small ${sortByScore ? "btn-primary" : "btn-secondary"}`, aria: { pressed: String(sortByScore) }, onClick: () => { sortByScore = true; draw(); } }, tr("点数の高い順", "By score")),
        ),
        table,
        h("p", { class: "muted small" }, tr("★ は最有力候補です（「参加できない」が最も少なく、点数の合計が最も大きい候補）。", "★ marks the best option (the fewest \"not available\" answers and the highest total score).")),
        matrix,
        h(
          "section",
          { class: "card" },
          h("h2", { class: "card-title" }, tr(`未回答（${unanswered.length} 名）`, `No answer yet (${unanswered.length})`)),
          h("p", {}, unanswered.length ? unanswered.map((p) => p.displayName).join(tr("、", ", ")) : tr("全員が回答しました。", "Everyone has answered.")),
          isOrganizer && unanswered.length && d.poll.status !== "draft" && d.poll.status !== "fixed" ? remindButton(d, (m) => void reload(m)) : null,
        ),
        syncPanel(d, () => void reload(notice("ok", tr("募集メッセージを更新しました。", "The poll message was updated.")))),
      ),
    );
  }

  function remindButton(d: PollData, done: (m: HTMLElement) => void): HTMLElement {
    const btn = h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-small",
        onClick: async () => {
          if (!confirm(tr("未回答の人にメンション付きでリマインドを投稿します。よろしいですか？（12 時間に 1 回まで）", "Post a reminder that mentions everyone who hasn't answered? (Once every 12 hours)"))) return;
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
  function unfixButton(d: PollData, s: PollData["slots"][number], label: string, done: (m: HTMLElement) => void): HTMLElement {
    const btn = h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-small",
        onClick: async () => {
          const ev = s.hasEvent ? tr("登録した Discord イベントも削除されます。", "The Discord event will also be deleted. ") : "";
          if (!confirm(tr(`${label} の確定を取り消します。${ev}よろしいですか？`, `Cancel the confirmation of ${label}? ${ev}`))) return;
          btn.disabled = true;
          try {
            const r = await request<{ warnings: string[] }>("DELETE", `/api/polls/${d.poll.id}/fix/${s.id}`);
            done(notice(r.warnings.length ? "warn" : "ok", tr(`${label} の確定を取り消しました。チャンネルへのお知らせは［確定をお知らせする］から投稿できます。`, `Cancelled the confirmation of ${label}. You can post an announcement to the channel with [Announce the dates].`), ...r.warnings.map((w) => ` ${w}`)));
          } catch (e) {
            done(notice("error", errorText(e, "summary", tr("確定を取り消せませんでした。", "Couldn't cancel the confirmation."))));
          }
        },
      },
      tr("確定を取り消す", "Cancel confirmation"),
    );
    return btn;
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

function fixPanel(d: PollData, slotId: string, cancel: () => void, done: (m: HTMLElement) => void): HTMLElement {
  const slot = d.slots.find((s) => s.id === slotId)!;
  const tz = viewerTimeZone();
  const otherFixed = d.slots.filter((s) => s.fixedAt !== null && s.id !== slotId).length;
  const useEvent = h("input", { type: "checkbox", id: "fix-event" });
  // サーバーの既定値（§5.3.1）でボイスチャンネルを決めていれば、「ボイスチャンネル」を最初から選ぶ
  const defaultChannel = d.defaultEventChannelId;
  const typeVoice = h("input", { type: "radio", name: "ev-type", id: "ev-voice", value: "voice", checked: !!defaultChannel });
  const typeExternal = h("input", { type: "radio", name: "ev-type", id: "ev-external", value: "external", checked: !defaultChannel });
  const voiceSel = h("select", { id: "ev-channel" }, h("option", { value: "" }, tr("読み込み中…", "Loading…")));
  // 最初に入れておく場所は、サーバーの既定値（§5.3.1）。決めていなければ「Discord」
  const location = h("input", { type: "text", id: "ev-location", maxLength: 100, value: d.defaultEventLocation ?? "Discord", autocomplete: "off" });
  const status = h("p", { role: "status", class: "muted" });
  let voiceLoaded = false;
  const loadVoice = async () => {
    if (voiceLoaded) return;
    voiceLoaded = true;
    try {
      const r = await request<{ channels: { id: string; name: string }[] }>("GET", `/api/polls/${d.poll.id}/voice-channels`);
      render(voiceSel, h("option", { value: "" }, tr("選んでください", "Choose")), ...r.channels.map((c) => h("option", { value: c.id }, c.name)));
      if (defaultChannel && r.channels.some((c) => c.id === defaultChannel)) voiceSel.value = defaultChannel;
      // 既定のチャンネルが消えていたら、「場所を入力」に戻す（選ばないまま確定するとイベントを登録できないため）
      else if (defaultChannel && typeVoice.checked) typeExternal.checked = true;
    } catch {
      render(voiceSel, h("option", { value: "" }, tr("読み込めませんでした", "Couldn't load")));
      if (defaultChannel && typeVoice.checked) typeExternal.checked = true;
    }
  };
  typeVoice.addEventListener("change", () => void loadVoice());
  if (defaultChannel) void loadVoice();
  const label = slotText(slot, d.poll.timezone, tz).main;
  const submit = h(
    "button",
    {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        submit.disabled = true;
        status.textContent = tr("確定しています…", "Confirming…");
        try {
          const r = await request<{ warnings: string[] }>("POST", `/api/polls/${d.poll.id}/fix`, {
            slotId,
            event: useEvent.checked
              ? { type: typeVoice.checked ? "voice" : "external", channelId: typeVoice.checked ? voiceSel.value || null : null, location: typeVoice.checked ? null : location.value.trim() || "Discord" }
              : null,
          });
          done(notice(r.warnings.length ? "warn" : "ok", tr(`${label} を確定しました。チャンネルへのお知らせは［確定をお知らせする］から投稿できます。`, `Confirmed ${label}. You can post an announcement to the channel with [Announce the dates].`), ...r.warnings.map((w) => ` ${w}`)));
        } catch (e) {
          status.textContent = errorText(e, "summary", tr("確定できませんでした。", "Couldn't confirm."));
          submit.disabled = false;
        }
      },
    },
    tr("この日時で確定", "Confirm this date"),
  );
  return h(
    "section",
    { class: "card fix-panel", aria: { label: tr("日時の確定", "Confirm a date") } },
    h("h2", { class: "card-title" }, tr("日時を確定する", "Confirm the date")),
    h("p", {}, h("strong", {}, label)),
    otherFixed ? h("p", { class: "muted small" }, tr(`ほかに確定している日時（${otherFixed} 件）は、そのまま残ります。`, `Other confirmed dates (${otherFixed}) stay as they are.`)) : null,
    h("p", { class: "muted small" }, tr("確定しても、チャンネルにはまだお知らせしません。お知らせは、確定のあとに［確定をお知らせする］から投稿します。", "Confirming doesn't announce anything to the channel yet. After confirming, post the announcement with [Announce the dates].")),
    h("div", { class: "field-inline" }, useEvent, h("label", { for: "fix-event" }, tr("Discord イベントとして登録する", "Create a Discord event"))),
    h(
      "fieldset",
      { class: "sub-fields" },
      h("legend", {}, tr("イベントの場所", "Event location")),
      h("div", { class: "field-inline" }, typeExternal, h("label", { for: "ev-external" }, tr("場所を入力", "Enter a location")), location),
      h("div", { class: "field-inline" }, typeVoice, h("label", { for: "ev-voice" }, tr("ボイスチャンネル", "Voice channel")), voiceSel),
    ),
    h("p", { class: "muted small" }, tr("確定後も、参加者は回答を変更できます。変更があればこの画面に表示されます。", "Participants can still change their answers after confirmation. Any changes are shown on this page.")),
    h("div", { class: "row row-end" }, h("button", { type: "button", class: "btn btn-secondary", onClick: cancel }, tr("キャンセル", "Cancel")), submit),
    status,
  );
}

/**
 * 確定のお知らせ（主催者）。いま確定している日時と、前回のお知らせのあとに取り消した日時を、1 つのメッセージにまとめて投稿する（§4.3）
 */
function announcePanel(d: PollData, done: (m: HTMLElement) => void): HTMLElement | null {
  const tz = viewerTimeZone();
  const fixed = d.slots.filter((s) => s.fixedAt !== null);
  const cancelled = d.slots.filter((s) => s.fixedAt === null && s.announced);
  if (!fixed.length && !cancelled.length) return null;
  const newly = fixed.filter((s) => !s.announced).length;
  const pending = newly + cancelled.length;
  const mention = h("input", { type: "checkbox", id: "announce-mention", checked: true });
  const status = h("p", { role: "status", class: "muted" });
  const btn = h(
    "button",
    {
      type: "button",
      class: pending ? "btn btn-primary" : "btn btn-secondary",
      onClick: async () => {
        if (!confirm(tr("確定した日時と取り消した日時を、チャンネルにまとめてお知らせします。よろしいですか？", "Announce the confirmed and cancelled dates to the channel in one message?"))) return;
        btn.disabled = true;
        status.textContent = tr("投稿しています…", "Posting…");
        try {
          const r = await request<{ warnings: string[] }>("POST", `/api/polls/${d.poll.id}/announce`, { mention: mention.checked });
          done(h("div", {}, notice(r.warnings.length ? "warn" : "ok", tr("確定のお知らせをチャンネルに投稿しました。", "Posted the announcement to the channel."), ...r.warnings.map((w) => ` ${w}`)), donationLine(d.donationUrl)));
        } catch (e) {
          status.textContent = errorText(e, "summary", tr("お知らせを投稿できませんでした。", "Couldn't post the announcement."));
          btn.disabled = false;
        }
      },
    },
    tr("確定をお知らせする", "Announce the dates"),
  );
  const list = (slots: typeof d.slots) => slots.map((s) => slotText(s, d.poll.timezone, tz).main).join(tr("、", ", "));
  return h(
    "section",
    { class: "card announce-panel", aria: { label: tr("確定のお知らせ", "Announcement") } },
    h("h2", { class: "card-title" }, tr("確定のお知らせ", "Announcement"), h("span", { class: "tag tag-optional" }, tr("主催者だけに表示", "Only you (the organizer) can see this"))),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, tr("確定した日時", "Confirmed dates")),
      h("dd", {}, fixed.length ? list(fixed) : tr("なし", "None")),
      cancelled.length ? h("dt", {}, tr("取り消した日時", "Cancelled dates")) : null,
      cancelled.length ? h("dd", {}, list(cancelled)) : null,
      h("dt", {}, tr("まだお知らせしていない変更", "Changes not yet announced")),
      h("dd", {}, pending ? tr(`あり（確定 ${newly} 件・取り消し ${cancelled.length} 件）`, `Yes (${newly} confirmed, ${cancelled.length} cancelled)`) : tr("なし（お知らせ済みです。もう一度投稿することもできます）", "None (already announced. You can post it again)")),
    ),
    h("div", { class: "field-inline" }, mention, h("label", { for: "announce-mention" }, d.poll.targetType === "role" ? tr("参加者のロールにメンションしてお知らせする", "Mention the participants' role in the announcement") : tr("@everyone にメンションしてお知らせする", "Mention @everyone in the announcement"))),
    h("div", { class: "row" }, btn),
    status,
  );
}
