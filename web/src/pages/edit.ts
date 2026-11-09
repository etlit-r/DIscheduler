// S2: 調整の作成・編集（主催者。docs/design.md §6.3, §6.9）
import { ApiError, loadPoll, request, type PollData } from "../lib/api";
import { browserTimeZone, choiceMark, dateTimeText, rememberDonation, showError, slotText, statusBanner, syncPanel, timeZoneSelect } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import {
  CHOICE_COLORS,
  CHOICE_KINDS,
  CHOICE_TEMPLATES,
  DEFAULT_COLOR,
  DEFAULT_SCORE,
  KIND_LABEL,
  LIMITS,
  type ChoiceColor,
  type ChoiceKind,
} from "../../../src/shared/model";
import { epochToZoned, formatSlot, zonedToEpoch } from "../../../src/shared/time";

interface SlotDraft {
  id: string | null;
  startAt: number;
  endAt: number | null;
  allDay: boolean;
}
interface ChoiceDraft {
  id: string | null;
  symbol: string;
  label: string;
  kind: ChoiceKind;
  score: number;
  color: ChoiceColor;
}

const COLOR_LABEL: Record<ChoiceColor, string> = { green: "緑", teal: "青緑", yellow: "黄", orange: "橙", red: "赤", gray: "灰" };

const pad = (n: number) => String(n).padStart(2, "0");
/** "HH:MM" の 1 時間後（24 時を過ぎたら 0 時から数える） */
function plusOneHour(hhmm: string): string {
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  return `${pad((hh + 1) % 24)}:${pad(mm)}`;
}

/** 「よく使う」の固定の時間帯 */
const FIXED_PRESETS = [
  { label: "昼 12:00–13:00", start: "12:00", end: "13:00" },
  { label: "夜 20:00–22:00", start: "20:00", end: "22:00" },
] as const;

export async function editPage(pollId: string): Promise<void> {
  let d: PollData;
  try {
    d = await loadPoll(pollId);
  } catch (e) {
    return showError(e);
  }
  rememberDonation(d.donationUrl);
  if (d.me.role !== "organizer") return showError(new ApiError(403, "forbidden", "この画面は主催者だけが開けます。"));

  // 調整のタイムゾーンが未設定なら、主催者のブラウザのタイムゾーンを使う（§6.7）
  if (!d.poll.timezoneSet) {
    const btz = browserTimeZone();
    if (btz !== d.poll.timezone) {
      await request("PATCH", `/api/polls/${pollId}`, { timezone: btz, timezoneAuto: true }).catch(() => undefined);
      d = await loadPoll(pollId);
    }
  }

  // --- 画面の状態 ---
  let title = d.poll.title ?? "";
  let description = d.poll.description ?? "";
  let tz = d.poll.timezone;
  let tzChanged = false;
  let joinPolicy = d.poll.joinPolicy;
  let deadlineLocal = d.poll.deadlineAt ? toLocalInput(d.poll.deadlineAt, tz) : "";
  let slots: SlotDraft[] = d.slots.map((s) => ({ ...s }));
  let slotsChanged = false;
  let choices: ChoiceDraft[] = d.choices.map((c) => ({ ...c }));
  let choicesChanged = false;
  const reassign = new Map<string, string>();
  let choiceEditorOpen = false;
  const today = epochToZoned(d.now, tz);
  let month = { y: today.year, m: today.month };
  const selectedDates = new Set<string>();
  // 日付の選び方。range のときは、始まりの日と終わりの日をタップして間の日をまとめて選ぶ
  let pickMode: "single" | "range" = "single";
  let rangeStart: string | null = null;
  let lastPicked: string | null = null; // Shift + クリックで範囲を選ぶときの起点
  // このサーバーで最近使った時間帯。固定の「よく使う」と同じものは出さない（§6.3.1）
  const recentPresets = (d.recentTimes ?? []).filter((r) => !FIXED_PRESETS.some((p) => p.start === r.start && p.end === r.end));
  let startTime = "20:00";
  let endTime = "22:00";
  let allDay = false;
  let message: HTMLElement | null = null;
  let searchResults: { userId: string; displayName: string }[] = [];
  let roles: { id: string; name: string }[] | null = null;
  let busy = false;

  const isDraft = d.poll.status === "draft";
  const choicesLocked = d.poll.status === "closed" || d.poll.status === "fixed";
  const answerCount = (choiceId: string) => d.answers.filter((a) => a.choiceId === choiceId).length;

  async function reloadAll(msg?: HTMLElement) {
    d = await loadPoll(pollId);
    slots = d.slots.map((s) => ({ ...s }));
    choices = d.choices.map((c) => ({ ...c }));
    slotsChanged = false;
    choicesChanged = false;
    reassign.clear();
    message = msg ?? null;
    draw();
  }

  async function save(): Promise<string[]> {
    // 公開後はタイトルを空にできない（募集メッセージの見出しになるため）
    if (!isDraft && !title.trim()) throw new Error("タイトルを入力してください。公開後はタイトルを空にできません。");
    const patch: Record<string, unknown> = { description: description.trim() ? description : null, joinPolicy };
    if (title.trim()) patch.title = title.trim();
    if (tzChanged) patch.timezone = tz;
    // 締切は変えたときだけ送る（過ぎた締切をそのまま送ると、保存全体が止まってしまうため）
    if (deadlineLocal) {
      const ep = fromLocalInput(deadlineLocal, tz);
      // 入力欄は分までなので、分単位で比べる（秒の違いで「変えた」と判定しない）
      if (ep !== null && (d.poll.deadlineAt === null || Math.floor(ep / 60) !== Math.floor(d.poll.deadlineAt / 60))) patch.deadlineAt = ep;
    }
    await request("PATCH", `/api/polls/${pollId}`, patch);
    tzChanged = false;
    const warnings: string[] = [];
    if (slotsChanged) {
      const r = await request<{ warnings?: string[] }>("PUT", `/api/polls/${pollId}/slots`, { slots });
      warnings.push(...(r.warnings ?? []));
      slotsChanged = false;
    }
    if (choicesChanged) {
      await request("PUT", `/api/polls/${pollId}/choices`, {
        choicesVersion: d.poll.choicesVersion,
        choices,
        reassign: [...reassign].map(([from, to]) => ({ from, to })),
      });
      choicesChanged = false;
    }
    return warnings;
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (e) {
      message = notice("error", e instanceof Error ? e.message : "エラーが発生しました。");
      draw();
    } finally {
      busy = false;
    }
  }

  // --- 部品 ---

  /** a〜b（順不同）の日付を、今日以降だけまとめて選ぶ */
  function selectRange(a: string, b: string): void {
    const [from, to] = a <= b ? [a, b] : [b, a];
    const todayKey = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
    const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
    for (let t = Date.UTC(fy, fm - 1, fd), i = 0; i < 366; t += 86400000, i++) {
      const d = new Date(t);
      const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      if (key > to) break;
      if (key >= todayKey) selectedDates.add(key);
    }
  }

  function modeButton(mode: "single" | "range", label: string): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        class: `btn btn-small ${pickMode === mode ? "btn-primary" : "btn-secondary"}`,
        aria: { pressed: String(pickMode === mode) },
        onClick: () => {
          pickMode = mode;
          rangeStart = null;
          draw();
        },
      },
      label,
    );
  }

  function pickHint(): string | HTMLElement[] {
    if (pickMode === "range" && rangeStart) {
      const [, m, d] = rangeStart.split("-").map(Number);
      return `${m}月${d}日から、終わりの日をタップしてください（別の月にも移れます）。`;
    }
    // 日付を選んだら、候補にするには［＋ 選択中の日付に追加］を押す必要があることを伝える
    if (selectedDates.size) return `${selectedDates.size} 日を選択中です。② で時間帯を決めて、下の［＋ 選択中の ${selectedDates.size} 日に追加］を押すと候補になります。`;
    if (pickMode === "range") return "始まりの日をタップしてください。";
    // Shift + クリックの案内は、幅の広い画面（パソコン）でだけ出す
    return [
      h("span", { class: "narrow-only" }, "日付をタップして選びます（複数可）。"),
      h("span", { class: "wide-only" }, "日付をタップして選びます（複数可。パソコンでは Shift キーを押しながらクリックすると範囲で選べます）。"),
    ];
  }

  /** 選んだ日付を候補に追加しないまま保存しようとしたら確かめる。追加しに戻るなら false */
  function confirmPendingDates(): boolean {
    if (selectedDates.size === 0) return true;
    if (confirm(`選択中の ${selectedDates.size} 日は、まだ候補に追加されていません。\n追加しないで保存しますか？\n（追加するときは［キャンセル］を押して、［＋ 選択中の ${selectedDates.size} 日に追加］を押してください）`)) return true;
    const btn = document.getElementById("add-slots");
    btn?.scrollIntoView({ block: "center" });
    btn?.focus();
    return false;
  }

  function calendar(): HTMLElement {
    const first = new Date(Date.UTC(month.y, month.m - 1, 1));
    const daysInMonth = new Date(Date.UTC(month.y, month.m, 0)).getUTCDate();
    const grid = h("div", { class: "cal-grid", role: "group", aria: { label: `${month.y}年${month.m}月` } });
    for (const w of ["日", "月", "火", "水", "木", "金", "土"]) grid.appendChild(h("span", { class: "cal-wd", aria: { hidden: "true" } }, w));
    for (let i = 0; i < first.getUTCDay(); i++) grid.appendChild(h("span", {}));
    const todayKey = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${month.y}-${pad(month.m)}-${pad(day)}`;
      const sel = selectedDates.has(key);
      grid.appendChild(
        h(
          "button",
          {
            type: "button",
            class: `cal-day${sel ? " is-selected" : ""}${key === todayKey ? " is-today" : ""}${key === rangeStart ? " is-range-start" : ""}`,
            aria: { pressed: String(sel), label: `${month.m}月${day}日` },
            disabled: key < todayKey,
            onClick: (e: MouseEvent) => {
              if (pickMode === "range") {
                if (rangeStart === null) {
                  rangeStart = key;
                } else {
                  selectRange(rangeStart, key);
                  rangeStart = null;
                }
              } else if (e.shiftKey && lastPicked && lastPicked !== key) {
                selectRange(lastPicked, key);
              } else if (sel) {
                selectedDates.delete(key);
              } else {
                selectedDates.add(key);
              }
              lastPicked = key;
              draw();
            },
          },
          String(day),
        ),
      );
    }
    const move = (delta: number) => {
      const nm = month.m + delta;
      month = { y: month.y + Math.floor((nm - 1) / 12), m: ((nm - 1 + 120) % 12) + 1 };
      draw();
    };
    return h(
      "div",
      { class: "calendar" },
      h(
        "div",
        { class: "cal-head" },
        h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => move(-1), aria: { label: "前の月" } }, "◀"),
        h("strong", {}, `${month.y}年${month.m}月`),
        h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => move(1), aria: { label: "次の月" } }, "▶"),
      ),
      h(
        "div",
        { class: "pick-mode", role: "group", aria: { label: "日付の選び方" } },
        modeButton("single", "1 日ずつ"),
        modeButton("range", "範囲で選ぶ"),
      ),
      grid,
      h("p", { class: "muted small", aria: { live: "polite" } }, ...[pickHint()].flat()),
      selectedDates.size || rangeStart
        ? h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { selectedDates.clear(); rangeStart = null; lastPicked = null; draw(); } }, "選択を解除")
        : null,
    );
  }

  function addSlots() {
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    let added = 0;
    for (const key of [...selectedDates].sort()) {
      const [y, m, dd] = key.split("-").map(Number) as [number, number, number];
      let s: SlotDraft;
      if (allDay) {
        s = { id: null, startAt: zonedToEpoch(y, m, dd, 0, 0, tz), endAt: null, allDay: true };
      } else {
        const startAt = zonedToEpoch(y, m, dd, sh ?? 0, sm ?? 0, tz);
        let endAt: number | null = zonedToEpoch(y, m, dd, eh ?? 0, em ?? 0, tz);
        if (endAt === startAt) endAt = null;
        else if (endAt < startAt) endAt += 86400; // 日付をまたぐ
        s = { id: null, startAt, endAt, allDay: false };
      }
      if (slots.some((x) => x.startAt === s.startAt && x.endAt === s.endAt)) continue;
      if (slots.length >= LIMITS.slotsMax) {
        message = notice("warn", `候補は ${LIMITS.slotsMax} 件までです。`);
        break;
      }
      slots.push(s);
      added++;
    }
    slots.sort((a, b) => a.startAt - b.startAt);
    if (added) {
      slotsChanged = true;
      selectedDates.clear();
    }
    draw();
  }

  function slotSection(): HTMLElement {
    const startIn: HTMLInputElement = h("input", {
      type: "time",
      id: "start-time",
      value: startTime,
      disabled: allDay,
      onChange: () => {
        if (!startIn.value) return;
        startTime = startIn.value;
        // 開始を決めたら、終了はその 1 時間後にする（日付をまたぐときは候補の追加時に翌日として扱う）
        endTime = plusOneHour(startTime);
        endIn.value = endTime;
      },
    });
    const endIn = h("input", { type: "time", id: "end-time", value: endTime, disabled: allDay, onChange: () => (endTime = endIn.value || endTime) });
    const allDayIn = h("input", { type: "checkbox", id: "all-day", checked: allDay, onChange: () => { allDay = allDayIn.checked; draw(); } });
    const preset = (label: string, s: string, e: string) =>
      h("button", { type: "button", class: "btn btn-small btn-raised", onClick: () => { startTime = s; endTime = e; allDay = false; draw(); } }, label);
    const list = h("ul", { class: "slot-list" });
    for (const s of slots) {
      const hasAnswers = s.id !== null && d.answers.some((a) => a.slotId === s.id);
      // 確定した候補（保存済みで id が一致するもの）は削除できないので、× を出さない。
      // 未保存の候補（id が null）を、未確定の調整（fixedSlotId が null）の確定候補と取り違えないよう id があるときだけ比べる
      const isFixed = s.id !== null && s.id === d.poll.fixedSlotId;
      list.appendChild(
        h(
          "li",
          {},
          h("span", {}, slotText(s, tz, tz).main),
          isFixed
            ? null
            : h(
                "button",
                {
                  type: "button",
                  class: "btn btn-secondary btn-small",
                  aria: { label: `${formatSlot(s, tz)} を削除` },
                  onClick: () => {
                    if (hasAnswers && !confirm("この候補には回答があります。削除すると回答も消えます。よろしいですか？")) return;
                    slots = slots.filter((x) => x !== s);
                    slotsChanged = true;
                    draw();
                  },
                },
                "×",
              ),
        ),
      );
    }
    return h(
      "section",
      { class: "card" },
      h("h2", { class: "card-title" }, "① 日付を選ぶ"),
      calendar(),
      h("h2", { class: "card-title" }, "② 時間帯"),
      h(
        "div",
        { class: "preset-row" },
        h("span", { class: "preset-label muted small" }, "よく使う:"),
        h("div", { class: "preset-btns" }, ...FIXED_PRESETS.map((p) => preset(p.label, p.start, p.end))),
      ),
      recentPresets.length
        ? h(
            "div",
            { class: "preset-row" },
            h("span", { class: "preset-label muted small" }, "最近使った:"),
            h("div", { class: "preset-btns" }, ...recentPresets.map((r) => preset(`${r.start}–${r.end}`, r.start, r.end))),
          )
        : null,
      // 開始・終了は、ラベルと入力欄を組にして並べる。1 行に収まらない幅では、それぞれを 1 行ずつ縦に並べる
      h(
        "div",
        { class: "time-fields" },
        h("div", { class: "time-field" }, h("label", { for: "start-time" }, "開始"), startIn),
        h("div", { class: "time-field" }, h("label", { for: "end-time" }, "終了"), endIn),
        h("div", { class: "time-field time-field-check" }, allDayIn, h("label", { for: "all-day" }, "終日")),
      ),
      selectedDates.size
        ? h("p", { class: "add-prompt", role: "status" }, `選んだ ${selectedDates.size} 日を候補にするには、このボタンを押してください。`)
        : null,
      h(
        "button",
        { type: "button", id: "add-slots", class: `btn btn-primary${selectedDates.size ? " btn-attention" : ""}`, disabled: selectedDates.size === 0, onClick: addSlots },
        selectedDates.size ? `＋ 選択中の ${selectedDates.size} 日に追加` : "＋ 選択中の日付に追加",
      ),
      h("h2", { class: "card-title" }, `③ 候補一覧（${slots.length} 件）`),
      slots.length ? list : h("p", { class: "muted" }, "まだ候補がありません。"),
    );
  }

  function choiceSection(): HTMLElement {
    const summary = h("p", { class: "choice-summary" }, ...choices.map((c) => h("span", { class: "choice-chip" }, choiceMark(c), c.label)));
    if (!choiceEditorOpen) {
      return h(
        "section",
        { class: "card" },
        h("h2", { class: "card-title" }, "④ 回答の選択肢"),
        summary,
        choicesLocked
          ? h("p", { class: "muted small" }, "締切後・確定後は選択肢を変更できません。")
          : h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { choiceEditorOpen = true; draw(); } }, "変更"),
      );
    }
    const tplSel = h(
      "select",
      {
        id: "tpl",
        onChange: () => {
          const t = CHOICE_TEMPLATES.find((x) => x.id === tplSel.value);
          if (!t) return;
          // いまの選択肢の ID を並び順で引き継ぐ（回答をそのまま残し、余った古い選択肢には移し先を選べるようにする）
          const keep = choices.map((c) => c.id);
          choices = t.choices.map((c, i) => ({ ...c, id: keep[i] ?? null }));
          choicesChanged = true;
          draw();
        },
      },
      h("option", { value: "" }, "ひな形から選ぶ…"),
      ...CHOICE_TEMPLATES.map((t) => h("option", { value: t.id }, `${t.name}（${t.choices.map((c) => c.symbol).join("")}）`)),
    );
    const rows = h("ol", { class: "choice-editor" });
    choices.forEach((c, i) => {
      const mark = () => { choicesChanged = true; };
      const sym = h("input", { type: "text", value: c.symbol, maxLength: 8, class: "in-symbol", aria: { label: `${i + 1} 番目の記号` }, onInput: () => { c.symbol = sym.value; mark(); } });
      const lab = h("input", { type: "text", value: c.label, maxLength: 10, class: "in-label", aria: { label: `${i + 1} 番目の名前` }, onInput: () => { c.label = lab.value; mark(); } });
      const kind = h(
        "select",
        { aria: { label: `${i + 1} 番目の区分` }, onChange: () => { c.kind = kind.value as ChoiceKind; c.score = DEFAULT_SCORE[c.kind]; c.color = DEFAULT_COLOR[c.kind]; mark(); draw(); } },
        ...CHOICE_KINDS.map((k) => h("option", { value: k, selected: k === c.kind }, KIND_LABEL[k])),
      );
      const score = h("input", { type: "number", min: "0", max: "10", value: String(c.score), class: "in-score", aria: { label: `${i + 1} 番目の点数` }, onInput: () => { c.score = Math.max(0, Math.min(10, Math.floor(Number(score.value) || 0))); mark(); } });
      const color = h(
        "select",
        { aria: { label: `${i + 1} 番目の色` }, onChange: () => { c.color = color.value as ChoiceColor; mark(); draw(); } },
        ...CHOICE_COLORS.map((k) => h("option", { value: k, selected: k === c.color }, COLOR_LABEL[k])),
      );
      const moveBtn = (delta: number, label: string) =>
        h("button", {
          type: "button",
          class: "btn btn-secondary btn-small",
          disabled: i + delta < 0 || i + delta >= choices.length,
          aria: { label },
          onClick: () => { const t = choices[i + delta]!; choices[i + delta] = c; choices[i] = t; mark(); draw(); },
        }, delta < 0 ? "↑" : "↓");
      rows.appendChild(
        h(
          "li",
          {},
          choiceMark(c),
          sym,
          lab,
          kind,
          score,
          color,
          moveBtn(-1, "上へ"),
          moveBtn(1, "下へ"),
          h("button", {
            type: "button",
            class: "btn btn-secondary btn-small",
            disabled: choices.length <= LIMITS.choicesMin,
            aria: { label: `${c.label} を削除` },
            onClick: () => { choices = choices.filter((x) => x !== c); mark(); draw(); },
          }, "削除"),
        ),
      );
    });
    // 回答がある選択肢を消すときの移し先（§6.9.4）
    const keptIds = new Set(choices.filter((c) => c.id).map((c) => c.id!));
    const removedWithAnswers = d.choices.filter((c) => !keptIds.has(c.id) && answerCount(c.id) > 0);
    const reassignFields = removedWithAnswers.map((rc) => {
      const sel = h(
        "select",
        { onChange: () => { if (sel.value) reassign.set(rc.id, sel.value); else reassign.delete(rc.id); choicesChanged = true; } },
        h("option", { value: "" }, "移し先を選ぶ"),
        ...choices.filter((c) => c.id).map((c) => h("option", { value: c.id!, selected: reassign.get(rc.id) === c.id }, `${c.symbol} ${c.label}`)),
      );
      return h("div", { class: "field-inline" }, h("span", {}, `「${rc.symbol} ${rc.label}」を選んだ回答（${answerCount(rc.id)} 件）の移し先: `), sel);
    });
    return h(
      "section",
      { class: "card" },
      h("h2", { class: "card-title" }, "④ 回答の選択肢"),
      h("div", { class: "row" }, h("label", { for: "tpl" }, "ひな形"), tplSel),
      h("p", { class: "muted small" }, "記号（1〜2 文字）・名前（10 文字まで）・区分・点数（0〜10。最有力候補の判定に使う）・色を設定できます。2〜5 個。"),
      rows,
      h("button", {
        type: "button",
        class: "btn btn-secondary btn-small",
        disabled: choices.length >= LIMITS.choicesMax,
        onClick: () => { choices.push({ id: null, symbol: "？", label: `選択肢${choices.length + 1}`, kind: "maybe", score: 1, color: "gray" }); choicesChanged = true; draw(); },
      }, `＋ 選択肢を追加（最大 ${LIMITS.choicesMax} 個）`),
      ...reassignFields,
      h("p", {}, "プレビュー: ", ...choices.map((c) => h("span", { class: `choice-btn choice-${c.color} is-preview` }, c.symbol, " ", c.label))),
    );
  }

  function participantSection(): HTMLElement {
    const list = h("ul", { class: "member-list" });
    for (const p of d.participants) {
      list.appendChild(
        h(
          "li",
          {},
          p.displayName,
          h("button", {
            type: "button",
            class: "btn btn-secondary btn-small",
            aria: { label: `${p.displayName} を参加者から外す` },
            onClick: () => run(async () => {
              if (!confirm(`${p.displayName} を参加者から外します。この人の回答も消えます。よろしいですか？`)) return;
              await request("PUT", `/api/polls/${pollId}/participants`, { add: [], remove: [p.userId] });
              await reloadAll(notice("ok", "参加者から外しました。"));
            }),
          }, "×"),
        ),
      );
    }
    const q = h("input", { type: "search", id: "member-q", maxLength: 32, placeholder: "名前で検索", autocomplete: "off" });
    const results = h("ul", { class: "member-list" });
    for (const r of searchResults) {
      const already = d.participants.some((p) => p.userId === r.userId);
      results.appendChild(
        h(
          "li",
          {},
          r.displayName,
          already
            ? h("span", { class: "muted small" }, "参加者です")
            : h("button", {
                type: "button",
                class: "btn btn-secondary btn-small",
                onClick: () => run(async () => {
                  await request("PUT", `/api/polls/${pollId}/participants`, { add: [r.userId], remove: [] });
                  await reloadAll(notice("ok", `${r.displayName} を追加しました。`));
                }),
              }, "追加"),
        ),
      );
    }
    const mode = d.poll.targetType === "manual" ? "manual" : "auto";
    const modeAuto = h("input", { type: "radio", name: "mode", id: "mode-auto", checked: mode === "auto", disabled: !isDraft });
    const modeManual = h("input", { type: "radio", name: "mode", id: "mode-manual", checked: mode === "manual", disabled: !isDraft });
    const roleSel = h("select", { id: "role", disabled: !isDraft || mode === "manual" }, h("option", { value: "" }, "なし（このチャンネルのメンバー）"));
    if (roles) for (const r of roles) roleSel.appendChild(h("option", { value: r.id, selected: r.id === d.poll.targetId }, r.name));
    else if (d.poll.targetId) roleSel.appendChild(h("option", { value: d.poll.targetId, selected: true }, "（指定したロール）"));
    const applyMode = () => run(async () => {
      // 参加者は設定し直され、手で追加・削除した内容は消えるので、先に確かめる
      if (!confirm("参加者の決め方を変えると、参加者が設定し直され、手で追加・削除した内容は元に戻ります。よろしいですか？")) {
        draw();
        return;
      }
      const members = modeManual.checked ? "manual" : "auto";
      const r = await request<{ notice: string | null }>("PATCH", `/api/polls/${pollId}`, { members, roleId: members === "manual" ? null : roleSel.value || null });
      await reloadAll(r.notice ? notice("warn", r.notice) : notice("ok", "参加者を設定し直しました。"));
    });
    modeAuto.addEventListener("change", applyMode);
    modeManual.addEventListener("change", applyMode);
    roleSel.addEventListener("change", applyMode);
    roleSel.addEventListener("focus", () => {
      if (roles || !isDraft) return;
      void request<{ roles: { id: string; name: string }[] }>("GET", `/api/polls/${pollId}/roles`).then((r) => { roles = r.roles; draw(); document.getElementById("role")?.focus(); }).catch(() => undefined);
    }, { once: true });
    const jpClosed = h("input", { type: "radio", name: "jp", id: "jp-closed", checked: joinPolicy === "closed", onChange: () => (joinPolicy = "closed") });
    const jpOpen = h("input", { type: "radio", name: "jp", id: "jp-open", checked: joinPolicy === "open", onChange: () => (joinPolicy = "open") });

    return h(
      "section",
      { class: "card" },
      h("h2", { class: "card-title" }, `参加者（${d.participants.length} 名）`),
      h(
        "fieldset",
        {},
        h("legend", {}, "決め方", isDraft ? "" : "（公開後は変更できません）"),
        h("div", { class: "field-inline" }, modeAuto, h("label", { for: "mode-auto" }, "自動（チャンネルのメンバー・ロールのメンバー）")),
        h("div", { class: "field-inline" }, modeManual, h("label", { for: "mode-manual" }, "手動で選ぶ")),
        h("div", { class: "field-inline" }, h("label", { for: "role" }, "ロール"), roleSel),
      ),
      d.participants.length ? list : h("p", { class: "muted" }, "参加者がいません。"),
      h(
        "form",
        {
          class: "row",
          onSubmit: (e) => {
            e.preventDefault();
            void run(async () => {
              const r = await request<{ members: { userId: string; displayName: string }[] }>("GET", `/api/polls/${pollId}/member-search?q=${encodeURIComponent(q.value.trim())}`);
              searchResults = r.members;
              if (!r.members.length) message = notice("info", "見つかりませんでした。");
              draw();
            });
          },
        },
        h("label", { for: "member-q" }, "メンバーを追加"),
        q,
        h("button", { type: "submit", class: "btn btn-secondary btn-small" }, "検索"),
      ),
      results,
      h(
        "fieldset",
        {},
        h("legend", {}, "参加者以外が［回答する］を押したとき"),
        h("div", { class: "field-inline" }, jpClosed, h("label", { for: "jp-closed" }, "回答できない")),
        h("div", { class: "field-inline" }, jpOpen, h("label", { for: "jp-open" }, "チャンネルを見られる人なら、参加者に追加して回答できる")),
      ),
    );
  }

  function draw(): void {
    setTitle(isDraft ? "新しい日程調整" : `${d.poll.title ?? ""} の編集`);
    const titleIn = h("input", {
      type: "text",
      id: "title",
      value: title,
      maxLength: LIMITS.titleMax,
      required: true,
      autocomplete: "off",
      onInput: () => {
        title = titleIn.value;
        // 入力のたびに画面全体を描き直さず、公開ボタンと案内だけを更新する
        if (publishBtn) publishBtn.disabled = !canPublish();
        updatePublishHint();
      },
    });
    const canPublish = () => title.trim().length > 0 && slots.length > 0;
    /** 公開に足りない項目（例: 「タイトルを入力してください。」） */
    const missingText = () => {
      const items = [!title.trim() ? "タイトル" : null, slots.length === 0 ? "候補日時" : null].filter((x): x is string => x !== null);
      return items.length ? `${items.join("と")}を入力してください。` : "";
    };
    const missingHint = h("p", { class: "missing-hint small right", aria: { live: "polite" } }, missingText());
    const publishHint = h(
      "div",
      { hidden: !isDraft || canPublish() },
      missingHint,
      h("p", { class: "muted small right" }, "公開するには、タイトルと候補日時（1 件以上）が必要です。"),
    );
    const updatePublishHint = () => {
      publishHint.hidden = !isDraft || canPublish();
      missingHint.textContent = missingText();
    };
    const descIn = h("textarea", { id: "desc", rows: 3, maxLength: LIMITS.descriptionMax, onInput: () => (description = descIn.value) });
    descIn.value = description;
    const tzSel = timeZoneSelect(tz, (v) => {
      if (slots.length && !confirm("タイムゾーンを変えても、入力済みの候補の日時（世界共通の時刻）は変わりません。表示だけが変わります。よろしいですか？")) {
        draw();
        return;
      }
      tz = v;
      tzChanged = true;
      if (deadlineLocal && d.poll.deadlineAt) deadlineLocal = toLocalInput(d.poll.deadlineAt, tz);
      draw();
    }, "poll-tz");
    const deadlineIn = h("input", { type: "datetime-local", id: "deadline", value: deadlineLocal, onChange: () => (deadlineLocal = deadlineIn.value) });

    const saveBtn = h("button", {
      type: "button",
      class: "btn btn-secondary",
      onClick: () => run(async () => {
        if (!confirmPendingDates()) return;
        const warnings = await save();
        await reloadAll(warnings.length ? notice("warn", "保存しました。", ...warnings.map((w) => h("p", {}, w))) : notice("ok", "保存しました。"));
      }),
    }, isDraft ? "下書きを保存" : "変更を保存");
    const publishBtn = isDraft
      ? h("button", {
          type: "button",
          class: "btn btn-primary",
          disabled: !canPublish(),
          onClick: () => run(async () => {
            if (!confirmPendingDates()) return;
            await save();
            const r = await request<{ redirect: string }>("POST", `/api/polls/${pollId}/publish`, {});
            location.assign(r.redirect);
          }),
        }, "公開してチャンネルに投稿")
      : null;

    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        h("h1", {}, isDraft ? "新しい日程調整" : "調整の編集"),
        statusBanner(d),
        message,
        syncPanel(d, () => void reloadAll(notice("ok", "募集メッセージを更新しました。"))),
        h(
          "section",
          { class: "card" },
          h("div", { class: "field" }, h("label", { for: "title" }, "タイトル", h("span", { class: "required" }, "（必須）")), titleIn),
          h("div", { class: "field" }, h("label", { for: "desc" }, "説明（任意・1000 文字まで）"), descIn),
          h("div", { class: "field" }, h("label", { for: "poll-tz" }, "タイムゾーン（候補日時を入力する基準）"), tzSel),
        ),
        slotSection(),
        choiceSection(),
        participantSection(),
        h(
          "section",
          { class: "card" },
          h("div", { class: "field" }, h("label", { for: "deadline" }, `締切（${tz}）`), deadlineIn),
          h("p", { class: "muted small" }, isDraft ? "未入力なら公開から 7 日後になります。締切を過ぎても回答の入力・変更はできます（目安です）。" : "締切を過ぎても回答の入力・変更はできます（目安です）。"),
        ),
        h(
          "div",
          { class: "row row-end sticky-actions" },
          isDraft ? null : h("a", { class: "btn btn-secondary", href: `/p/${pollId}` }, "集計画面へ"),
          saveBtn,
          publishBtn,
        ),
        publishHint,
        h(
          "section",
          { class: "card danger-zone" },
          h("h2", { class: "card-title" }, "調整の削除"),
          h("p", { class: "muted small" }, "削除すると、候補・回答などのデータはすぐに消え、元に戻せません。募集メッセージは「削除されました」に変わります。"),
          h("button", {
            type: "button",
            class: "btn btn-danger btn-small",
            onClick: () => run(async () => {
              if (!confirm("この調整を削除します。元に戻せません。よろしいですか？")) return;
              const r = await request<{ warnings?: string[] }>("DELETE", `/api/polls/${pollId}`, {});
              render(
                document.getElementById("app")!,
                h(
                  "section",
                  { class: "page" },
                  h("h1", {}, "調整を削除しました"),
                  h("p", {}, "データはすべて削除されました。"),
                  ...(r.warnings ?? []).map((w) => notice("warn", w)),
                  h("p", {}, h("a", { href: "/" }, "DIscheduler の案内へ")),
                ),
              );
            }),
          }, "この調整を削除"),
        ),
        d.poll.deadlineAt && !isDraft ? h("p", { class: "muted small" }, `現在の締切: ${dateTimeText(d.poll.deadlineAt, tz)}`) : null,
      ),
    );
  }

  draw();
}

function toLocalInput(epoch: number, tz: string): string {
  const p = epochToZoned(epoch, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function fromLocalInput(v: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  return zonedToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
}
