// 画面共通の部品
import { ApiError, request, type PollData } from "../lib/api";
import { h, lineIcon, notice, render } from "../lib/dom";
import { donationNote } from "../../../src/shared/text";
import { DEFAULT_TIMEZONE, formatDateTime, formatSlot, isValidTimeZone, zoneAbbr, type SlotTime } from "../../../src/shared/time";

const TZ_KEY = "dis.viewerTz";

export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** 閲覧者の表示タイムゾーン（ブラウザの localStorage にだけ保存する。§6.7） */
export function viewerTimeZone(): string {
  try {
    const saved = localStorage.getItem(TZ_KEY);
    if (saved && isValidTimeZone(saved)) return saved;
  } catch {
    /* 保存できない環境では既定値 */
  }
  return browserTimeZone();
}

export function setViewerTimeZone(tz: string): void {
  try {
    localStorage.setItem(TZ_KEY, tz);
  } catch {
    /* 無視 */
  }
}

export function allTimeZones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = f ? f("timeZone") : [DEFAULT_TIMEZONE, "UTC"];
  return list.includes("UTC") ? list : [...list, "UTC"];
}

type TzEntry = { id: string; name: string; offset: string; haystack: string };
let tzEntries: TzEntry[] | null = null;

/** タイムゾーンの一覧に、日本語の名前と UTC からの差を添える（検索に使う。最初に開いたときに 1 回だけ作る） */
function timeZoneEntries(): TzEntry[] {
  if (tzEntries) return tzEntries;
  const now = new Date();
  const part = (tz: string, style: Intl.DateTimeFormatOptions["timeZoneName"]): string => {
    try {
      return new Intl.DateTimeFormat("ja-JP", { timeZone: tz, timeZoneName: style }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {
      return "";
    }
  };
  tzEntries = allTimeZones().map((id) => {
    const name = part(id, "longGeneric") || part(id, "long");
    const gmt = part(id, "shortOffset"); // 例: GMT+9、GMT-3:30、GMT
    const offset = gmt.replace(/^GMT/, "UTC") || "UTC";
    const haystack = normalizeTzQuery([id, id.replace(/_/g, " "), name, offset, gmt, offset.replace(/^UTC/, "")].join(" "));
    return { id, name, offset, haystack };
  });
  return tzEntries;
}

function normalizeTzQuery(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[_\s]+/g, " ");
}

/** 入力した文字列（空白区切りのすべての語を含むもの）に合うタイムゾーン */
export function filterTimeZones(query: string): TzEntry[] {
  const words = normalizeTzQuery(query).split(" ").filter(Boolean);
  const all = timeZoneEntries();
  if (!words.length) return all;
  return all.filter((e) => words.every((w) => e.haystack.includes(w)));
}

/**
 * タイムゾーンの選択欄。文字を入れると一覧を絞り込める（例: Tokyo、日本、+9）。
 * 一覧はボタンではなく listbox（WAI-ARIA の combobox）で、矢印キーと Enter でも選べる。
 * 一覧にあるタイムゾーンしか選べない（決めずに離れると、元の値に戻す）
 */
export function timeZoneSelect(current: string, onChange: (tz: string) => void, id = "tz", align: "left" | "right" = "left"): HTMLElement {
  let value = current;
  let matches: TzEntry[] = [];
  let active = -1;
  const listId = `${id}-list`;
  const input = h("input", {
    type: "text",
    id,
    value,
    autocomplete: "off",
    role: "combobox",
    placeholder: "検索（例: Tokyo、日本、+9）",
    aria: { autocomplete: "list", expanded: "false", controls: listId },
  });
  input.spellcheck = false;
  const list = h("ul", { id: listId, class: `tz-list tz-list-${align}`, role: "listbox", hidden: true, aria: { label: "タイムゾーンの候補" } });

  const open = (query: string) => {
    matches = filterTimeZones(query);
    active = matches.findIndex((e) => e.id === value);
    if (active < 0 && matches.length) active = 0;
    list.replaceChildren(
      ...matches.map((e, i) => {
        const li = h(
          "li",
          { id: `${listId}-${i}`, role: "option", class: "tz-option", aria: { selected: String(e.id === value) } },
          h("span", { class: "tz-id" }, e.id),
          h("span", { class: "tz-meta" }, [e.name, e.offset].filter(Boolean).join("・")),
        );
        // 入力欄からフォーカスが外れる前に選べるよう、mousedown で決める
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          pick(e.id);
        });
        return li;
      }),
    );
    if (!matches.length) list.appendChild(h("li", { class: "tz-empty" }, "見つかりませんでした"));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight();
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const highlight = () => {
    list.querySelectorAll(".tz-option.is-active").forEach((el) => el.classList.remove("is-active"));
    const el = active >= 0 ? document.getElementById(`${listId}-${active}`) : null;
    if (el) {
      el.classList.add("is-active");
      el.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", el.id);
    } else input.removeAttribute("aria-activedescendant");
  };
  const pick = (tz: string) => {
    close();
    input.value = tz;
    if (tz === value) return;
    value = tz;
    onChange(tz);
  };

  input.addEventListener("focus", () => {
    input.select();
    open("");
  });
  input.addEventListener("click", () => {
    if (list.hidden) open("");
  });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (list.hidden) return open(input.value);
      if (!matches.length) return;
      active = ev.key === "ArrowDown" ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, 0);
      highlight();
    } else if (ev.key === "Enter") {
      if (list.hidden) return;
      ev.preventDefault();
      const e = matches[active];
      if (e) pick(e.id);
    } else if (ev.key === "Escape") {
      if (list.hidden) return;
      ev.preventDefault();
      close();
      input.value = value;
    }
  });
  input.addEventListener("blur", () => {
    close();
    input.value = value;
  });

  return h("div", { class: "tz-picker" }, input, list);
}

/** ヘッダー右上の表示タイムゾーン切り替え（S3・S4） */
export function mountViewerTzSwitch(onChange: () => void): void {
  const tools = document.getElementById("header-tools");
  if (!tools) return;
  const picker = timeZoneSelect(viewerTimeZone(), (tz) => {
    setViewerTimeZone(tz);
    onChange();
  }, "viewer-tz", "right");
  picker.classList.add("tz-switch");
  render(tools, h("label", { class: "visually-hidden", for: "viewer-tz" }, "表示するタイムゾーン"), picker);
}

/** 候補日時の表示。閲覧者のタイムゾーンが調整と違えば両方を出す（§6.7） */
export function slotText(slot: SlotTime, pollTz: string, viewerTz: string): { main: string; sub: string | null } {
  const main = `${formatSlot(slot, pollTz)} ${slot.allDay ? "" : zoneAbbr(slot.startAt, pollTz)}`.trim();
  if (viewerTz === pollTz || slot.allDay) return { main, sub: null };
  return { main, sub: `あなたの時刻: ${formatSlot(slot, viewerTz)} ${zoneAbbr(slot.startAt, viewerTz)}` };
}

export function dateTimeText(epoch: number, tz: string): string {
  return `${formatDateTime(epoch, tz)} ${zoneAbbr(epoch, tz)}`;
}

export function choiceMark(c: { symbol: string; label: string; color: string }, extra = ""): HTMLElement {
  return h("span", { class: `mark mark-${c.color} ${extra}`.trim(), title: c.label, aria: { label: c.label } }, c.symbol);
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  open: "募集中",
  closed: "締切後",
  fixed: "確定",
  cancelled: "削除済み",
};

/** エラーが出た画面の種類。リンクの期限が切れたときに、どのボタンを押し直せばよいかの案内を変える */
export type PageKind = "answer" | "summary" | "edit" | "done" | "link";

/** サーバーのメッセージだけで、新しいリンクの受け取り方まで伝えているエラー */
const SELF_EXPLAINING = new Set(["list_session_expired", "link_expired"]);

/** リンク（セッション）の期限が切れたときに、新しいリンクを受け取る方法 */
export function reopenHint(kind: PageKind): string {
  switch (kind) {
    case "answer":
      return "チャンネルの募集メッセージの［回答する］を、もう一度押してください。";
    case "summary":
      return "チャンネルの募集メッセージの［集計を見る］を、もう一度押してください。";
    case "edit":
    case "done":
      return "Discord でもう一度 /schedule を実行し、［作成した調整を管理］を押して、新しいリンクを受け取ってください。";
    default:
      return "参加者はチャンネルの募集メッセージの［回答する］または［集計を見る］を、主催者は Discord で /schedule を実行して［作成した調整を管理］を、もう一度押してください。";
  }
}

/** 画面の中に出すエラーの文。リンクの期限切れなら、新しいリンクを受け取る方法を添える */
export function errorText(e: unknown, kind: PageKind, fallback: string): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : fallback;
  if (e.status === 401 && !SELF_EXPLAINING.has(e.code)) return `${e.message}${reopenHint(kind)}`;
  return e.message;
}

/** エラー画面（S5） */
export function showError(err: unknown, kind: PageKind = "link"): void {
  const app = document.getElementById("app")!;
  const e = err instanceof ApiError ? err : new ApiError(0, "unknown", "エラーが発生しました。");
  const freeTier = e.code === "free_tier_exceeded";
  render(
    app,
    h(
      "section",
      { class: "card error-card" },
      h("h1", {}, freeTier ? "本日の無料枠を超えました" : e.status === 401 || e.status === 404 ? "ページを開けません" : "エラーが発生しました"),
      h("p", {}, e.message),
      // リンクの期限切れは、画面に合わせて押し直すボタンを案内する。
      // 一覧ページの期限切れと、中継ページで使えなかったリンクは、サーバーのメッセージで受け取り方まで伝えるので、ここでは出さない
      e.status === 401 && !SELF_EXPLAINING.has(e.code) ? h("p", {}, reopenHint(kind)) : null,
      freeTier && donationFromError ? h("p", {}, "運営を支援していただけると、有料プランへの切り替えを検討できます: ", h("a", { href: donationFromError, rel: "noopener noreferrer" }, "運営を支援する")) : null,
      h("p", {}, h("a", { href: "/manual/" }, "DIscheduler のマニュアルへ")),
    ),
  );
}

/** コーヒーカップ（Lucide の coffee。public/assets/lucide-LICENSE.txt） */
const COFFEE_PATHS = ["M10 2v2", "M14 2v2", "M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1", "M6 2v2"] as const;

/**
 * 完了の画面に置く寄付リンク（§6.10）。枠で囲み、コーヒーカップの絵を添える。
 * 回答の完了画面（public/answered.html）と同じ形にする。寄付リンクがなければ null
 */
export function donationLine(url: string | null): HTMLElement | null {
  if (!url) return null;
  const note = donationNote(url);
  const cup = h("span", { class: "support-cup" });
  cup.appendChild(lineIcon("support-cup-ic", COFFEE_PATHS));
  return h(
    "aside",
    { class: "support-card", aria: { label: "運営の支援" } },
    cup,
    h(
      "div",
      { class: "support-body" },
      h("p", { class: "support-lead" }, "DIscheduler は無料で運営しています。役に立ったら、運営を支援していただけるとうれしいです。"),
      h("p", {}, h("a", { class: "btn btn-secondary btn-small", href: url, rel: "noopener noreferrer" }, "運営を支援する")),
      h("p", { class: "term" }, "任意です。支援の有無で機能は変わりません。"),
      note ? h("p", { class: "term" }, note) : null,
    ),
  );
}

let donationFromError: string | null = null;
export function rememberDonation(url: string | null): void {
  donationFromError = url;
}

/** 募集メッセージの更新状況（主催者だけ。§6.5） */
export function syncPanel(d: PollData, reload: () => void): HTMLElement | null {
  if (d.me.role !== "organizer" || d.poll.status === "draft") return null;
  const repostStatus = h("p", { class: "muted", role: "status" });
  const repostBtn = h(
    "button",
    {
      class: d.poll.messageUrl ? "btn btn-secondary btn-small" : "btn btn-primary btn-small",
      type: "button",
      onClick: async () => {
        const msg = d.poll.messageUrl
          ? "募集メッセージをチャンネルに投稿し直します（いまのメッセージは削除します）。よろしいですか？"
          : "募集メッセージをチャンネルにもう一度投稿します。よろしいですか？";
        if (!confirm(msg)) return;
        repostBtn.disabled = true;
        repostStatus.textContent = "投稿しています…";
        try {
          await request("POST", `/api/polls/${d.poll.id}/repost`, {});
          reload();
        } catch (e) {
          repostStatus.textContent = errorText(e, "summary", "投稿できませんでした。");
          repostBtn.disabled = false;
        }
      },
    },
    d.poll.messageUrl ? "チャンネルに投稿し直す" : "もう一度投稿する",
  );
  if (!d.poll.messageUrl) {
    // Discord で募集メッセージが削除されると、［回答する］ボタンもなくなるため、投稿し直せるようにする
    return h(
      "section",
      { class: "card sync-panel", aria: { label: "募集メッセージ" } },
      h("h2", { class: "card-title" }, "チャンネルの募集メッセージ", h("span", { class: "tag tag-optional" }, "主催者だけに表示")),
      notice("warn", "募集メッセージが見つかりません。Discord で削除された可能性があります。参加者が［回答する］を押せるよう、もう一度投稿してください。"),
      h("div", { class: "row" }, repostBtn),
      repostStatus,
    );
  }
  const tz = viewerTimeZone();
  const pending = d.poll.pendingChanges ?? 0;
  const status = h("p", { class: "muted", role: "status" });
  const btn = h(
    "button",
    {
      class: "btn btn-secondary btn-small",
      type: "button",
      onClick: async () => {
        btn.disabled = true;
        status.textContent = "更新しています…";
        try {
          await request("POST", `/api/polls/${d.poll.id}/sync-message`, {});
          reload();
        } catch (e) {
          status.textContent = errorText(e, "summary", "更新できませんでした。");
          btn.disabled = false;
        }
      },
    },
    "今すぐ更新",
  );
  return h(
    "section",
    { class: "card sync-panel", aria: { label: "募集メッセージの更新状況" } },
    h("h2", { class: "card-title" }, "チャンネルの募集メッセージ", h("span", { class: "tag tag-optional" }, "主催者だけに表示")),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "最終更新"),
      h("dd", {}, d.poll.lastSyncedAt ? dateTimeText(d.poll.lastSyncedAt, tz) : "まだ更新していません"),
      h("dt", {}, "未反映の回答の変更"),
      h("dd", {}, pending > 0 ? `あり（${pending} 件）` : "なし（回答は反映済みです。締切などの表示を最新にしたいときも［今すぐ更新］を押せます）"),
      h("dt", {}, "次の自動更新"),
      h("dd", {}, d.poll.nextAutoSyncAt ? dateTimeText(d.poll.nextAutoSyncAt, tz) : "—", d.poll.status === "fixed" ? "" : "（回答の保存時にも自動で更新されます）"),
    ),
    h("div", { class: "row" }, btn, h("a", { href: d.poll.messageUrl, rel: "noopener noreferrer" }, "募集メッセージを開く"), repostBtn),
    status,
    repostStatus,
  );
}

export function statusBanner(d: PollData): HTMLElement | null {
  const tz = viewerTimeZone();
  const fixed = d.slots.filter((x) => x.fixedAt !== null);
  if (d.poll.status === "fixed" && fixed.length) {
    const when = fixed.map((s) => slotText(s, d.poll.timezone, tz).main).join("、");
    return notice("ok", h("strong", {}, `${when} に確定しています。`), " 予定が変わった場合は回答を変更してください。");
  }
  if (d.poll.status === "closed") return notice("info", "締切を過ぎています。回答の入力・変更はできます。");
  if (d.poll.status === "draft") return notice("info", "この調整はまだ公開されていません。");
  return null;
}
