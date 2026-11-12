// S3: 回答入力（各候補の集計つき。docs/design.md §6.4）
import { loadPoll, request, type PollData } from "../lib/api";
import { choiceMark, dateTimeText, mountViewerTzSwitch, rememberDonation, showError, slotText, statusBanner, viewerTimeZone, errorText } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { bestSlotId, canAnswer, tally } from "../../../src/shared/model";
import { formatDate, formatSlotTime, zoneAbbr } from "../../../src/shared/time";

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

    // 日付を見出しにまとめ、行には時間帯だけを書く（日付は調整のタイムゾーンで決める。候補は日時の順に並んでいる）
    const list = h("div", { class: "answer-list" });
    let day: HTMLElement | null = null;
    let dayLabel = "";
    for (const s of d.slots) {
      const st = slotText(s, d.poll.timezone, tz);
      const label = formatDate(s.startAt, d.poll.timezone);
      if (!day || label !== dayLabel) {
        dayLabel = label;
        day = h("ol", { class: "answer-day", aria: { label } });
        list.append(h("h2", { class: "answer-date" }, label), day);
      }
      // 閲覧者のタイムゾーンが違うときだけ、略号（JST など）を付ける（slotText と同じ決まり）
      const time = formatSlotTime(s, d.poll.timezone) + (st.sub ? ` ${zoneAbbr(s.startAt, d.poll.timezone)}` : "");
      const tt = t.get(s.id)!;
      const isFixed = s.fixedAt !== null;
      const group = h("div", { class: "choice-group", role: "radiogroup", aria: { label: `${st.main} の回答` } });
      for (const c of d.choices) {
        const selected = draft.get(s.id) === c.id;
        group.appendChild(
          h(
            "button",
            {
              type: "button",
              // 1 行に収めるため、ボタンには記号だけを出す。名前は読み上げとマウスを乗せたときの表示、表の上の凡例で伝える
              class: `choice-btn choice-btn-compact choice-${c.color}${selected ? " is-selected" : ""}`,
              role: "radio",
              title: c.label,
              aria: { checked: String(selected), label: `${c.symbol} ${c.label}` },
              disabled: !editable,
              onClick: () => {
                draft.set(s.id, c.id);
                draw();
              },
            },
            h("span", { class: "choice-symbol", aria: { hidden: "true" } }, c.symbol),
          ),
        );
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

      // 1 件を 1 行にまとめる: 左に日時と集計（人数だけ）、右に選択ボタン。狭い画面でボタンが入らなければ、ボタンだけ次の行に回る
      day.appendChild(
        h(
          "li",
          { class: `answer-row${isFixed ? " is-fixed" : ""}` },
          h(
            "div",
            { class: "answer-when" },
            h(
              "div",
              { class: "slot-head" },
              isFixed ? h("span", { class: "badge badge-fixed" }, "確定") : s.id === best ? h("span", { class: "star", aria: { label: "最有力候補" } }, "★") : null,
              h("span", { class: "slot-main" }, time),
            ),
            st.sub ? h("span", { class: "slot-sub" }, st.sub) : null,
            h(
              "div",
              { class: "tally-line" },
              h("span", { class: "visually-hidden" }, "いまの回答: "),
              ...d.choices.map((c) => h("span", { class: "tally-item" }, choiceMark(c, "mark-tiny"), String(tt.byChoice[c.id] ?? 0))),
              h("span", { class: "tally-item muted" }, `未回答 ${d.participants.length - tt.answered}`),
              tt.answered ? who : null,
            ),
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
      h(
        "p",
        { class: "choice-legend muted small" },
        ...d.choices.flatMap((c, i) => [i ? "　" : "", choiceMark(c, "mark-tiny"), ` ${c.label}`]),
      ),
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
