// 回答画面（S3）の右に、利用者自身の Google カレンダーを表示する（パソコンの幅だけ。docs/design.md §6.4）。
// Google のアカウント情報（OAuth・API）は使わず、Google カレンダーの埋め込み（calendar.google.com/calendar/embed）で表示する。
// - 利用者が［Google カレンダーを表示］を押すまでは、何も表示せず、Google にも接続しない。
// - 表示するカレンダーの ID（多くは Gmail のアドレス）は利用者が入力し、このブラウザ（localStorage）にだけ保存する。サーバーには送らない。
// - 埋め込みで予定が見えるのは、Google の Cookie が埋め込みに渡るブラウザ（Chromium 系）だけなので、それ以外ではボタンも出さない。
// 回答画面は操作のたびに #app を描き直すので、欄（iframe）とボタンは #app の外に置き、描き直しで読み込み直さないようにする。
import { h } from "../lib/dom";
import { LANG, tr } from "../lib/i18n";
import { epochToZoned } from "../lib/time";
import { viewerTimeZone } from "./common";

const KEY = "dis.gcal";
/** 右に欄を出せる幅（本文 ＋ 欄が並ぶ幅） */
const WIDE = "(min-width: 1280px)";
const CAL_ID = /^[A-Za-z0-9._%+-]{1,200}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,}$/;

/** カレンダー ID の形か（メールアドレスの形。…@group.calendar.google.com などを含む） */
export function isCalendarId(v: string): boolean {
  return v.length <= 254 && CAL_ID.test(v);
}

function loadId(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && isCalendarId(v) ? v : null;
  } catch {
    return null;
  }
}

function saveId(v: string | null): void {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    // 保存できなくても、この画面では表示する
  }
}

/** 埋め込みで予定が見えるブラウザか（Chromium 系。既定でサードパーティの Cookie を止める Brave は除く） */
export function canEmbedCalendar(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? [];
  const names = brands.map((b) => b.brand);
  return names.includes("Chromium") && !names.includes("Brave");
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}${pad(m)}${pad(d)}`;

/** 埋め込みのアドレス。最初の候補の日から 1 週間を、表示中のタイムゾーンで出す */
export function calendarEmbedUrl(calendarId: string, firstStartAt: number | null, tz: string, lang: "ja" | "en"): string {
  const q = new URLSearchParams({ src: calendarId, ctz: tz, mode: "WEEK", hl: lang, showTitle: "0", showPrint: "0", showCalendars: "0" });
  if (firstStartAt !== null) {
    const p = epochToZoned(firstStartAt, tz);
    const end = new Date(Date.UTC(p.year, p.month - 1, p.day + 7));
    q.set("dates", `${ymd(p.year, p.month, p.day)}/${ymd(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate())}`);
  }
  return `https://calendar.google.com/calendar/embed?${q.toString()}`;
}

export interface GcalPanel {
  /** 表示するタイムゾーンが変わったとき（表示中なら、そのタイムゾーンで読み込み直す） */
  onTimeZoneChange(): void;
}

/**
 * 回答画面に、Google カレンダーを表示するボタンと右の欄を付ける。画面の読み込み時に 1 回だけ呼ぶ。
 * firstStartAt: 最初の候補の開始時刻（候補がなければ null）
 */
export function mountGcalPanel(firstStartAt: number | null): GcalPanel {
  const none: GcalPanel = { onTimeZoneChange: () => undefined };
  const actions = document.querySelector(".site-header .header-actions");
  const main = document.getElementById("main");
  if (!actions || !main || !canEmbedCalendar() || typeof matchMedia !== "function") return none;

  const wide = matchMedia(WIDE);
  let open = false;
  /** いま表示に使うカレンダー ID。保存できないブラウザでも、この画面では表示できるよう、保存とは別に持つ */
  let currentId: string | null = loadId();
  let frame: HTMLIFrameElement | null = null;

  const panel = h("aside", { id: "side-panel", class: "side-panel", aria: { label: tr("Google カレンダー", "Google Calendar") } });
  panel.hidden = true;
  main.appendChild(panel);
  const toggle = h("button", { type: "button", id: "gcal-toggle", class: "btn btn-secondary btn-small gcal-toggle", aria: { expanded: "false", controls: "side-panel" } });
  actions.insertBefore(toggle, document.getElementById("lang-switch"));

  const frameSrc = (id: string) => calendarEmbedUrl(id, firstStartAt, viewerTimeZone(), LANG === "en" ? "en" : "ja");

  function close(): void {
    open = false;
    frame = null;
    panel.replaceChildren();
    panel.hidden = true;
    document.body.classList.remove("has-side");
    update();
  }

  function form(): HTMLElement {
    const input = h("input", { type: "text", id: "gcal-id", autocomplete: "off", placeholder: tr("例: name@gmail.com", "e.g. name@gmail.com"), value: currentId ?? "" });
    input.spellcheck = false;
    const error = h("p", { class: "missing-hint small", role: "alert" });
    const submit = () => {
      const v = input.value.trim();
      if (!isCalendarId(v)) {
        error.textContent = tr("カレンダー ID の形が正しくありません（例: name@gmail.com）。", "The calendar ID isn't valid (e.g. name@gmail.com).");
        return;
      }
      currentId = v;
      saveId(v);
      draw();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      }
    });
    return h(
      "div",
      { class: "gcal-form" },
      h("h2", { class: "card-title" }, tr("Google カレンダーを隣に表示", "Show Google Calendar alongside")),
      h("p", { class: "small" }, tr("自分の予定を見ながら回答できます。表示するカレンダーの ID（多くは Gmail のアドレス）を入れてください。", "See your own schedule while you answer. Enter the ID of the calendar to show (usually your Gmail address).")),
      h("div", { class: "field" }, h("label", { for: "gcal-id" }, tr("カレンダー ID", "Calendar ID")), input),
      error,
      h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary btn-small", onClick: submit }, tr("表示する", "Show"))),
      h(
        "ul",
        { class: "muted small gcal-notes" },
        h("li", {}, tr("ID は Google カレンダーの「設定 → マイカレンダーの設定 → カレンダーの統合 → カレンダー ID」で確かめられます。", "You can find the ID in Google Calendar under Settings → Settings for my calendars → Integrate calendar → Calendar ID.")),
        h("li", {}, tr("このブラウザで Google にログインしていると、予定が見えます。シークレットウィンドウや、サードパーティの Cookie を止める設定では見えないことがあります。", "Your events appear if you're signed in to Google in this browser. They may not appear in an incognito window or if third-party cookies are blocked.")),
        h("li", {}, tr("ID はこのブラウザにだけ保存し、DIscheduler のサーバーには送りません。表示している間は、ブラウザが Google に直接接続します。", "The ID is saved only in this browser and is never sent to the DIscheduler server. While the calendar is shown, your browser connects to Google directly.")),
      ),
    );
  }

  function draw(): void {
    const id = currentId;
    panel.hidden = false;
    document.body.classList.add("has-side");
    const tools = h(
      "div",
      { class: "side-panel-tools" },
      id ? h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { currentId = null; saveId(null); draw(); } }, tr("ID を消す", "Forget ID")) : null,
      h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => { close(); toggle.focus(); } }, tr("閉じる", "Close")),
    );
    if (!id) {
      frame = null;
      panel.replaceChildren(tools, form());
      document.getElementById("gcal-id")?.focus();
      return;
    }
    frame = h("iframe", { class: "gcal-frame", title: tr("Google カレンダー", "Google Calendar") });
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms");
    frame.src = frameSrc(id);
    panel.replaceChildren(tools, frame);
  }

  function update(): void {
    toggle.hidden = !wide.matches;
    toggle.textContent = open ? tr("Google カレンダーを閉じる", "Close Google Calendar") : tr("Google カレンダーを表示", "Show Google Calendar");
    toggle.setAttribute("aria-expanded", String(open));
  }

  toggle.addEventListener("click", () => {
    if (open) return close();
    open = true;
    update();
    draw();
  });
  // 幅が狭くなったら欄を取り除く（通信も止める）。広くなってもボタンを出すだけで、自動では開かない
  wide.addEventListener("change", () => {
    if (!wide.matches && open) close();
    else update();
  });
  update();

  return {
    onTimeZoneChange: () => {
      if (frame && currentId) frame.src = frameSrc(currentId);
    },
  };
}
