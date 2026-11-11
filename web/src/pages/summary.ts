// S4: 集計・確定（docs/design.md §6.5）
import { loadPoll, request, type PollData } from "../lib/api";
import { choiceMark, dateTimeText, donationLine, mountViewerTzSwitch, rememberDonation, showError, slotText, STATUS_LABEL, statusBanner, syncPanel, viewerTimeZone, errorText } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { bestSlotId, compareSlots, tally, UNANSWERED } from "../../../src/shared/model";

export async function summaryPage(pollId: string): Promise<void> {
  let data: PollData;
  try {
    data = await loadPoll(pollId);
  } catch (e) {
    return showError(e, "summary");
  }
  rememberDonation(data.donationUrl);
  let sortByScore = false;
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
    setTitle(d.poll.title ?? "集計");
    const slots = d.slots.map((s) => ({ id: s.id, startAt: s.startAt }));
    const t = tally(slots, d.choices, d.answers);
    const best = bestSlotId(slots, t);
    const order = [...d.slots];
    if (sortByScore) order.sort((a, b) => compareSlots(a, t.get(a.id)!, b, t.get(b.id)!));
    const answered = new Set(d.answers.map((a) => a.userId));
    const nameOf = new Map(d.participants.map((p) => [p.userId, p.displayName]));
    const choiceById = new Map(d.choices.map((c) => [c.id, c]));
    // 「候補:メンバー」→ 回答。表の各マスで毎回探さないよう、先に索引を作る
    const answerAt = new Map(d.answers.map((a) => [`${a.slotId}:${a.userId}`, a]));
    const symbolOf = (id: string) => (id === UNANSWERED ? "未回答" : (choiceById.get(id)?.symbol ?? "?"));
    const canFix = isOrganizer && (d.poll.status === "open" || d.poll.status === "closed" || d.poll.status === "fixed");

    // 候補ごとの集計表
    const head = h("tr", {}, h("th", { scope: "col" }, "候補"), ...d.choices.map((c) => h("th", { scope: "col" }, choiceMark(c))), h("th", { scope: "col" }, "未回答"));
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
            isFixed ? h("span", { class: "badge badge-fixed" }, "確定") : s.id === best ? h("span", { class: "star", aria: { label: "最有力候補" } }, "★ ") : null,
            st.main,
            st.sub ? h("span", { class: "slot-sub" }, st.sub) : null,
            changed.length
              ? h(
                  "span",
                  { class: "changed-note" },
                  "確定後に変更: ",
                  changed
                    .map((a) => `${nameOf.get(a.userId) ?? "?"}（${symbolOf(a.prevChoiceId!)}→${symbolOf(a.choiceId)}、${dateTimeText(a.updatedAt, tz)}）`)
                    .join("、"),
                )
              : null,
            // 確定の操作は日時の下に置く（狭い画面でも横にスクロールせずに押せるように）
            canFix
              ? h(
                  "div",
                  { class: "fix-actions" },
                  isFixed
                    ? unfixButton(d, s, st.main, (m) => void reload(m))
                    : h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { fixTarget = s.id; draw(); } }, "確定"),
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
    const matrixHead = h("tr", {}, h("th", { scope: "col" }, "メンバー"), ...d.slots.map((s) => h("th", { scope: "col" }, slotText(s, d.poll.timezone, tz).main)));
    const matrixBody = h("tbody");
    for (const p of d.participants) {
      matrixBody.appendChild(
        h(
          "tr",
          { class: p.userId === d.me.userId ? "is-me" : "" },
          h("th", { scope: "row" }, p.displayName, p.comment ? h("span", { class: "slot-sub" }, p.comment) : null),
          ...d.slots.map((s) => {
            const a = answerAt.get(`${s.id}:${p.userId}`);
            const c = a ? choiceById.get(a.choiceId) : undefined;
            return h("td", { class: "num" }, c ? choiceMark(c) : h("span", { class: "muted" }, "—"));
          }),
        ),
      );
    }
    const matrix = h(
      "details",
      { class: "card" },
      h("summary", {}, "メンバー別に表示"),
      h("div", { class: "table-wrap matrix" }, h("table", { class: "data" }, h("thead", {}, matrixHead), matrixBody)),
    );

    const unanswered = d.participants.filter((p) => !answered.has(p.userId));

    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        h("h1", {}, d.poll.title ?? "日程調整", " ", h("span", { class: "tag tag-optional" }, STATUS_LABEL[d.poll.status] ?? "")),
        h("p", { class: "meta" }, `回答 ${answered.size}/${d.participants.length} 名`, d.poll.deadlineAt ? h("span", {}, h("span", { class: "sep" }, "／"), `締切 ${dateTimeText(d.poll.deadlineAt, tz)}`) : null),
        d.poll.description ? h("p", { class: "description" }, d.poll.description) : null,
        statusBanner(d),
        message,
        h(
          "div",
          { class: "row" },
          d.me.isParticipant && d.poll.status !== "draft" ? h("a", { class: "btn btn-primary", href: `/p/${pollId}/answer` }, "回答する・変更する") : null,
          isOrganizer ? h("a", { class: "btn btn-secondary", href: `/p/${pollId}/edit` }, "調整を編集する") : null,
          h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => void reload() }, "↻ 更新"),
        ),
        fixTarget ? fixPanel(d, fixTarget, () => { fixTarget = null; draw(); }, (m) => { fixTarget = null; void reload(m); }) : null,
        isOrganizer ? announcePanel(d, (m) => void reload(m)) : null,
        h(
          "div",
          { class: "row" },
          h("span", { class: "muted small" }, "並び順:"),
          h("button", { type: "button", class: `btn btn-small ${sortByScore ? "btn-secondary" : "btn-primary"}`, aria: { pressed: String(!sortByScore) }, onClick: () => { sortByScore = false; draw(); } }, "日時順"),
          h("button", { type: "button", class: `btn btn-small ${sortByScore ? "btn-primary" : "btn-secondary"}`, aria: { pressed: String(sortByScore) }, onClick: () => { sortByScore = true; draw(); } }, "点数の高い順"),
        ),
        table,
        h("p", { class: "muted small" }, "★ は最有力候補です（「参加できない」が最も少なく、点数の合計が最も大きい候補）。"),
        matrix,
        h(
          "section",
          { class: "card" },
          h("h2", { class: "card-title" }, `未回答（${unanswered.length} 名）`),
          h("p", {}, unanswered.length ? unanswered.map((p) => p.displayName).join("、") : "全員が回答しました。"),
          isOrganizer && unanswered.length && d.poll.status !== "draft" && d.poll.status !== "fixed" ? remindButton(d, (m) => void reload(m)) : null,
        ),
        syncPanel(d, () => void reload(notice("ok", "募集メッセージを更新しました。"))),
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
          if (!confirm("未回答の人にメンション付きでリマインドを投稿します。よろしいですか？（12 時間に 1 回まで）")) return;
          btn.disabled = true;
          try {
            const r = await request<{ count: number }>("POST", `/api/polls/${d.poll.id}/remind`, {});
            done(notice("ok", `${r.count} 名にリマインドしました。`));
          } catch (e) {
            done(notice("error", errorText(e, "summary", "リマインドできませんでした。")));
          }
        },
      },
      "未回答者にリマインド",
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
          const ev = s.hasEvent ? "登録した Discord イベントも削除されます。" : "";
          if (!confirm(`${label} の確定を取り消します。${ev}よろしいですか？`)) return;
          btn.disabled = true;
          try {
            const r = await request<{ warnings: string[] }>("DELETE", `/api/polls/${d.poll.id}/fix/${s.id}`);
            done(notice(r.warnings.length ? "warn" : "ok", `${label} の確定を取り消しました。チャンネルへのお知らせは［確定をお知らせする］から投稿できます。`, ...r.warnings.map((w) => ` ${w}`)));
          } catch (e) {
            done(notice("error", errorText(e, "summary", "確定を取り消せませんでした。")));
          }
        },
      },
      "確定を取り消す",
    );
    return btn;
  }

  draw();
}

function fixPanel(d: PollData, slotId: string, cancel: () => void, done: (m: HTMLElement) => void): HTMLElement {
  const slot = d.slots.find((s) => s.id === slotId)!;
  const tz = viewerTimeZone();
  const otherFixed = d.slots.filter((s) => s.fixedAt !== null && s.id !== slotId).length;
  const useEvent = h("input", { type: "checkbox", id: "fix-event" });
  const typeVoice = h("input", { type: "radio", name: "ev-type", id: "ev-voice", value: "voice" });
  const typeExternal = h("input", { type: "radio", name: "ev-type", id: "ev-external", value: "external", checked: true });
  const voiceSel = h("select", { id: "ev-channel" }, h("option", { value: "" }, "読み込み中…"));
  const location = h("input", { type: "text", id: "ev-location", maxLength: 100, value: "Discord", autocomplete: "off" });
  const status = h("p", { role: "status", class: "muted" });
  let voiceLoaded = false;
  const loadVoice = async () => {
    if (voiceLoaded) return;
    voiceLoaded = true;
    try {
      const r = await request<{ channels: { id: string; name: string }[] }>("GET", `/api/polls/${d.poll.id}/voice-channels`);
      render(voiceSel, h("option", { value: "" }, "選んでください"), ...r.channels.map((c) => h("option", { value: c.id }, c.name)));
    } catch {
      render(voiceSel, h("option", { value: "" }, "読み込めませんでした"));
    }
  };
  typeVoice.addEventListener("change", () => void loadVoice());
  const label = slotText(slot, d.poll.timezone, tz).main;
  const submit = h(
    "button",
    {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        submit.disabled = true;
        status.textContent = "確定しています…";
        try {
          const r = await request<{ warnings: string[] }>("POST", `/api/polls/${d.poll.id}/fix`, {
            slotId,
            event: useEvent.checked
              ? { type: typeVoice.checked ? "voice" : "external", channelId: typeVoice.checked ? voiceSel.value || null : null, location: typeVoice.checked ? null : location.value.trim() || "Discord" }
              : null,
          });
          done(notice(r.warnings.length ? "warn" : "ok", `${label} を確定しました。チャンネルへのお知らせは［確定をお知らせする］から投稿できます。`, ...r.warnings.map((w) => ` ${w}`)));
        } catch (e) {
          status.textContent = errorText(e, "summary", "確定できませんでした。");
          submit.disabled = false;
        }
      },
    },
    "この日時で確定",
  );
  return h(
    "section",
    { class: "card fix-panel", aria: { label: "日時の確定" } },
    h("h2", { class: "card-title" }, "日時を確定する"),
    h("p", {}, h("strong", {}, label)),
    otherFixed ? h("p", { class: "muted small" }, `ほかに確定している日時（${otherFixed} 件）は、そのまま残ります。`) : null,
    h("p", { class: "muted small" }, "確定しても、チャンネルにはまだお知らせしません。お知らせは、確定のあとに［確定をお知らせする］から投稿します。"),
    h("div", { class: "field-inline" }, useEvent, h("label", { for: "fix-event" }, "Discord イベントとして登録する")),
    h(
      "fieldset",
      { class: "sub-fields" },
      h("legend", {}, "イベントの場所"),
      h("div", { class: "field-inline" }, typeExternal, h("label", { for: "ev-external" }, "場所を入力"), location),
      h("div", { class: "field-inline" }, typeVoice, h("label", { for: "ev-voice" }, "ボイスチャンネル"), voiceSel),
    ),
    h("p", { class: "muted small" }, "確定後も、参加者は回答を変更できます。変更があればこの画面に表示されます。"),
    h("div", { class: "row row-end" }, h("button", { type: "button", class: "btn btn-secondary", onClick: cancel }, "キャンセル"), submit),
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
        if (!confirm("確定した日時と取り消した日時を、チャンネルにまとめてお知らせします。よろしいですか？")) return;
        btn.disabled = true;
        status.textContent = "投稿しています…";
        try {
          const r = await request<{ warnings: string[] }>("POST", `/api/polls/${d.poll.id}/announce`, { mention: mention.checked });
          done(notice(r.warnings.length ? "warn" : "ok", "確定のお知らせをチャンネルに投稿しました。", ...r.warnings.map((w) => ` ${w}`), donationLine(d.donationUrl)));
        } catch (e) {
          status.textContent = errorText(e, "summary", "お知らせを投稿できませんでした。");
          btn.disabled = false;
        }
      },
    },
    "確定をお知らせする",
  );
  const list = (slots: typeof d.slots) => slots.map((s) => slotText(s, d.poll.timezone, tz).main).join("、");
  return h(
    "section",
    { class: "card announce-panel", aria: { label: "確定のお知らせ" } },
    h("h2", { class: "card-title" }, "確定のお知らせ", h("span", { class: "tag tag-optional" }, "主催者だけに表示")),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "確定した日時"),
      h("dd", {}, fixed.length ? list(fixed) : "なし"),
      cancelled.length ? h("dt", {}, "取り消した日時") : null,
      cancelled.length ? h("dd", {}, list(cancelled)) : null,
      h("dt", {}, "まだお知らせしていない変更"),
      h("dd", {}, pending ? `あり（確定 ${newly} 件・取り消し ${cancelled.length} 件）` : "なし（お知らせ済みです。もう一度投稿することもできます）"),
    ),
    h("div", { class: "field-inline" }, mention, h("label", { for: "announce-mention" }, d.poll.targetType === "role" ? "参加者のロールにメンションしてお知らせする" : "@everyone にメンションしてお知らせする")),
    h("div", { class: "row" }, btn),
    status,
  );
}
