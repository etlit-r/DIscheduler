// S3: 回答入力（各候補の集計つき。docs/design.md §6.4）
import { loadPoll, request, type PollData } from "../api";
import { choiceMark, dateTimeText, mountViewerTzSwitch, rememberDonation, showError, slotText, statusBanner, viewerTimeZone } from "../common";
import { h, notice, render, setTitle } from "../dom";
import { bestSlotId, canAnswer, tally } from "../../../src/shared/model";

export async function answerPage(pollId: string): Promise<void> {
  const app = document.getElementById("app")!;
  let data: PollData;
  try {
    data = await loadPoll(pollId);
  } catch (e) {
    return showError(e);
  }
  rememberDonation(data.donationUrl);
  if (!data.me.isParticipant) {
    location.replace(`/p/${pollId}`);
    return;
  }

  // 入力中の内容（保存するまで集計には入れない）
  const draft = new Map<string, string>();
  for (const a of data.answers) if (a.userId === data.me.userId) draft.set(a.slotId, a.choiceId);
  let comment = data.me.comment ?? "";
  let message: HTMLElement | null = null;

  const reload = async (msg?: HTMLElement) => {
    try {
      data = await loadPoll(pollId);
      message = msg ?? null;
      draw();
    } catch (e) {
      showError(e);
    }
  };

  mountViewerTzSwitch(() => draw());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reload(message ?? undefined);
  });

  function draw(): void {
    const d = data;
    const tz = viewerTimeZone();
    setTitle(d.poll.title ?? "回答");
    const saved = d.answers.map((a) => ({ slotId: a.slotId, userId: a.userId, choiceId: a.choiceId }));
    const slots = d.slots.map((s) => ({ id: s.id, startAt: s.startAt }));
    const t = tally(slots, d.choices, saved);
    const best = bestSlotId(slots, t);
    const answeredUsers = new Set(d.answers.map((a) => a.userId));
    const nameOf = new Map(d.participants.map((p) => [p.userId, p.displayName]));
    const editable = canAnswer(d.poll.status);
    const first = d.choices[0];
    const last = d.choices[d.choices.length - 1];

    const list = h("ol", { class: "answer-list" });
    for (const s of d.slots) {
      const st = slotText(s, d.poll.timezone, tz);
      const tt = t.get(s.id)!;
      const isFixed = s.id === d.poll.fixedSlotId;
      const group = h("div", { class: "choice-group", role: "radiogroup", aria: { label: `${st.main} の回答` } });
      for (const c of d.choices) {
        const selected = draft.get(s.id) === c.id;
        group.appendChild(
          h(
            "button",
            {
              type: "button",
              class: `choice-btn choice-${c.color}${selected ? " is-selected" : ""}`,
              role: "radio",
              aria: { checked: String(selected) },
              disabled: !editable,
              onClick: () => {
                draft.set(s.id, c.id);
                draw();
              },
            },
            h("span", { class: "choice-symbol", aria: { hidden: "true" } }, c.symbol),
            h("span", {}, c.label),
          ),
        );
      }
      const bar = h("div", { class: "bar", aria: { hidden: "true" } });
      const total = Math.max(d.participants.length, 1);
      for (const kind of ["ok", "maybe", "ng"] as const) {
        const seg = h("span", { class: `bar-seg bar-${kind}` });
        seg.style.width = `${(tt[kind] / total) * 100}%`;
        bar.appendChild(seg);
      }
      const who = h("details", { class: "who" }, h("summary", {}, "誰が"));
      const whoList = h("ul", { class: "who-list" });
      for (const c of d.choices) {
        const names = d.answers.filter((a) => a.slotId === s.id && a.choiceId === c.id).map((a) => nameOf.get(a.userId) ?? "?");
        if (names.length) whoList.appendChild(h("li", {}, choiceMark(c), " ", names.join("、")));
      }
      const notAnswered = d.participants.filter((p) => !d.answers.some((a) => a.slotId === s.id && a.userId === p.userId)).map((p) => p.displayName);
      if (notAnswered.length) whoList.appendChild(h("li", {}, h("span", { class: "muted" }, "未回答"), " ", notAnswered.join("、")));
      who.appendChild(whoList);

      list.appendChild(
        h(
          "li",
          { class: `answer-item${isFixed ? " is-fixed" : ""}` },
          h(
            "div",
            { class: "slot-head" },
            isFixed ? h("span", { class: "badge badge-fixed" }, "確定") : s.id === best ? h("span", { class: "star", aria: { label: "最有力候補" } }, "★") : null,
            h("span", { class: "slot-main" }, st.main),
            st.sub ? h("span", { class: "slot-sub" }, st.sub) : null,
          ),
          tt.answered === 0
            ? h("p", { class: "tally muted" }, "まだ回答がありません")
            : h(
                "div",
                { class: "tally" },
                h("span", { class: "muted" }, "いまの回答: "),
                ...d.choices.map((c) => h("span", { class: "tally-item" }, choiceMark(c, "mark-small"), String(tt.byChoice[c.id] ?? 0))),
                bar,
                who,
              ),
          group,
        ),
      );
    }

    const commentInput = h("input", {
      id: "comment",
      type: "text",
      maxLength: 100,
      value: comment,
      disabled: !editable,
      autocomplete: "off",
      onInput: () => (comment = commentInput.value),
    });
    const saveBtn = h("button", { type: "submit", class: "btn btn-primary", disabled: !editable }, "保存する");
    const form = h(
      "form",
      {
        class: "answer-form",
        onSubmit: async (e) => {
          e.preventDefault();
          saveBtn.disabled = true;
          try {
            await request("PUT", `/api/polls/${pollId}/answers/me`, {
              choicesVersion: d.poll.choicesVersion,
              answers: [...draft].map(([slotId, choiceId]) => ({ slotId, choiceId })),
              comment: comment.trim() ? comment.trim() : null,
            });
            await reload(notice("ok", "保存しました。集計にあなたの回答が反映されました。"));
          } catch (err) {
            message = notice("error", err instanceof Error ? err.message : "保存できませんでした。");
            saveBtn.disabled = false;
            draw();
          }
        },
      },
      list,
      editable && first && last
        ? h(
            "div",
            { class: "row" },
            h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { for (const s of d.slots) draft.set(s.id, first.id); draw(); } }, `すべて${first.symbol}`),
            h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { for (const s of d.slots) draft.set(s.id, last.id); draw(); } }, `すべて${last.symbol}`),
          )
        : null,
      h("div", { class: "field" }, h("label", { for: "comment" }, "ひとこと（任意・100 文字まで）"), commentInput),
      h("p", { class: "muted small" }, "あなたの回答とひとことは、この調整の参加者全員に表示されます。参加者以外には表示されません。"),
      h("div", { class: "row row-end" }, h("a", { class: "btn btn-secondary", href: `/p/${pollId}` }, "集計表を見る"), saveBtn),
    );

    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        h("h1", {}, d.poll.title ?? "日程調整"),
        h(
          "p",
          { class: "meta" },
          d.poll.deadlineAt ? `締切 ${dateTimeText(d.poll.deadlineAt, tz)}` : "",
          h("span", { class: "sep" }, "／"),
          `あなた: ${d.me.displayName ?? ""}`,
          h("span", { class: "sep" }, "／"),
          `回答 ${answeredUsers.size}/${d.participants.length} 名`,
          " ",
          h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => void reload() }, "↻ 更新"),
        ),
        d.poll.description ? h("p", { class: "description" }, d.poll.description) : null,
        statusBanner(d),
        message,
        form,
      ),
    );
  }

  draw();
  void app;
}
