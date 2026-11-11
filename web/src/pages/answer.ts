// S3: 回答入力（各候補の集計つき。docs/design.md §6.4）
import { loadPoll, request, type PollData } from "../lib/api";
import { choiceMark, dateTimeText, mountViewerTzSwitch, rememberDonation, showError, slotText, statusBanner, viewerTimeZone, errorText } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { bestSlotId, canAnswer, tally } from "../../../src/shared/model";

export async function answerPage(pollId: string): Promise<void> {
  const app = document.getElementById("app")!;
  let data: PollData;
  try {
    data = await loadPoll(pollId);
  } catch (e) {
    return showError(e, "answer");
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
      showError(e, "answer");
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
    // 候補ごとの回答の索引（描画のたびに全回答を探し直さない）
    const bySlot = new Map<string, typeof d.answers>();
    for (const a of d.answers) {
      const list = bySlot.get(a.slotId);
      if (list) list.push(a);
      else bySlot.set(a.slotId, [a]);
    }
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
      const who = h("details", { class: "who" }, h("summary", {}, "みんなの回答"));
      const whoList = h("ul", { class: "who-list" });
      const slotAnswers = bySlot.get(s.id) ?? [];
      const answeredHere = new Set(slotAnswers.map((a) => a.userId));
      for (const c of d.choices) {
        const names = slotAnswers.filter((a) => a.choiceId === c.id).map((a) => nameOf.get(a.userId) ?? "?");
        if (names.length) whoList.appendChild(h("li", {}, choiceMark(c), " ", names.join("、")));
      }
      const notAnswered = d.participants.filter((p) => !answeredHere.has(p.userId)).map((p) => p.displayName);
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
            // 回答の完了画面へ移る（広告の枠はこの画面にだけ出す。§6.4, §6.10.1）。
            // 調整の ID は # の後ろに置き、サーバーのログにも広告の枠にも送らない
            location.assign(`/answered#p=${pollId}`);
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
        // まだ誰も回答を保存していないときは、最初の回答者だと分かるようにする（§6.4）
        editable && d.answers.length === 0 ? notice("info", "あなたが最初の入力者です。") : null,
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
        // 回答したあとに主催者が選択肢を変えていたら知らせる（§6.9.4）
        // ［確認しました］を押すまで表示する（ひとことだけの保存などでは消さない）
        d.me.needsChoicesAck && d.poll.choicesChangedAt
          ? notice(
              "warn",
              `回答のあとで、主催者が選択肢を変更しました（${dateTimeText(d.poll.choicesChangedAt, tz)}）。あなたの回答の意味が変わっていないか確認してください。 `,
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn-secondary btn-small",
                  onClick: async () => {
                    try {
                      await request("POST", `/api/polls/${pollId}/choices-ack`, {});
                      await reload();
                    } catch (e) {
                      message = notice("error", errorText(e, "answer", "保存できませんでした。"));
                      draw();
                    }
                  },
                },
                "確認しました",
              ),
            )
          : null,
        message,
        form,
      ),
    );
  }

  draw();
  void app;
}
