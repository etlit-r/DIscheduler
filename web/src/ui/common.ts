// 画面共通の部品
import { ApiError, request, type PollData } from "../lib/api";
import { h, notice, render } from "../lib/dom";
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

export function timeZoneSelect(current: string, onChange: (tz: string) => void, id = "tz"): HTMLSelectElement {
  const sel = h("select", { id, onChange: () => onChange(sel.value) });
  for (const tz of allTimeZones()) sel.appendChild(h("option", { value: tz, selected: tz === current }, tz));
  return sel;
}

/** ヘッダー右上の表示タイムゾーン切り替え（S3・S4） */
export function mountViewerTzSwitch(onChange: () => void): void {
  const tools = document.getElementById("header-tools");
  if (!tools) return;
  const sel = timeZoneSelect(viewerTimeZone(), (tz) => {
    setViewerTimeZone(tz);
    onChange();
  }, "viewer-tz");
  sel.classList.add("tz-switch");
  render(tools, h("label", { class: "visually-hidden", for: "viewer-tz" }, "表示するタイムゾーン"), sel);
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

/** エラー画面（S5） */
export function showError(err: unknown): void {
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
      e.status === 401 ? h("p", { class: "muted" }, "Discord の募集メッセージの［回答する］［集計を見る］、または /schedule の［自分の調整を管理］から、もう一度リンクを開いてください。") : null,
      freeTier && donationFromError ? h("p", {}, "運営を支援していただけると、有料プランへの切り替えを検討できます: ", h("a", { href: donationFromError, rel: "noopener noreferrer" }, "運営を支援する")) : null,
      h("p", {}, h("a", { href: "/" }, "DIscheduler の案内へ")),
    ),
  );
}

let donationFromError: string | null = null;
export function rememberDonation(url: string | null): void {
  donationFromError = url;
}

/** 募集メッセージの更新状況（主催者だけ。§6.5） */
export function syncPanel(d: PollData, reload: () => void): HTMLElement | null {
  if (d.me.role !== "organizer" || !d.poll.messageUrl) return null;
  const tz = viewerTimeZone();
  const pending = d.poll.pendingChanges ?? 0;
  const status = h("p", { class: "muted", role: "status" });
  const btn = h(
    "button",
    {
      class: "btn btn-secondary btn-small",
      type: "button",
      disabled: pending === 0,
      onClick: async () => {
        btn.disabled = true;
        status.textContent = "更新しています…";
        try {
          await request("POST", `/api/polls/${d.poll.id}/sync-message`, {});
          reload();
        } catch (e) {
          status.textContent = e instanceof Error ? e.message : "更新できませんでした。";
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
      h("dd", {}, pending > 0 ? `あり（${pending} 件）` : "なし（最新です）"),
      h("dt", {}, "次の自動更新"),
      h("dd", {}, d.poll.nextAutoSyncAt ? dateTimeText(d.poll.nextAutoSyncAt, tz) : "—", d.poll.status === "fixed" ? "" : "（回答の保存時にも自動で更新されます）"),
    ),
    h("div", { class: "row" }, btn, h("a", { href: d.poll.messageUrl, rel: "noopener noreferrer" }, "募集メッセージを開く")),
    status,
  );
}

export function statusBanner(d: PollData): HTMLElement | null {
  const tz = viewerTimeZone();
  if (d.poll.status === "fixed" && d.poll.fixedSlotId) {
    const s = d.slots.find((x) => x.id === d.poll.fixedSlotId);
    if (!s) return null;
    const t = slotText(s, d.poll.timezone, tz);
    return notice("ok", h("strong", {}, `${t.main} に確定しています。`), " 予定が変わった場合は回答を変更してください。");
  }
  if (d.poll.status === "closed") return notice("info", "締切を過ぎています。回答の入力・変更はできます。");
  if (d.poll.status === "draft") return notice("info", "この調整はまだ公開されていません。");
  return null;
}
