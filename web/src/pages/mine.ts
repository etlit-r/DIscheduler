// S9: 主催者の調整一覧（docs/design.md §6.11）
// Discord の［自分の調整を管理］から開く。このサーバーで自分が主催した調整だけを表示し、編集・集計・削除ができる。
import { ApiError, request, setCsrf } from "../lib/api";
import { h, notice, render, setTitle } from "../lib/dom";
import { dateTimeText, showError, viewerTimeZone } from "../ui/common";
import { formatSlot } from "../../../src/shared/time";
import type { PollStatus } from "../../../src/shared/model";

interface MinePoll {
  id: string;
  title: string | null;
  status: PollStatus;
  deadlineAt: number | null;
  timezone: string;
  fixed: { startAt: number; endAt: number | null; allDay: boolean } | null;
  participants: number;
  answered: number;
  createdAt: number;
  updatedAt: number;
  messageUrl: string | null;
}

type Filter = "all" | "draft" | "open" | "closed" | "fixed";
const STATUS_LABEL: Record<string, string> = { draft: "下書き", open: "募集中", closed: "締切後", fixed: "確定" };
const FILTERS: [Filter, string][] = [
  ["all", "すべて"],
  ["draft", "下書き"],
  ["open", "募集中"],
  ["closed", "締切後"],
  ["fixed", "確定"],
];

export async function minePage(guildId: string): Promise<void> {
  const base = `/api/guilds/${guildId}`;
  let polls: MinePoll[];
  try {
    const d = await request<{ now: number; csrfToken: string; polls: MinePoll[] }>("GET", `${base}/polls`);
    setCsrf(d.csrfToken);
    polls = d.polls;
  } catch (e) {
    return showError(e);
  }
  const tz = viewerTimeZone();
  let filter: Filter = "all";
  let message: HTMLElement | null = null;
  let busy = false;

  async function open(p: MinePoll, to: "edit" | "summary"): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const r = await request<{ redirect: string }>("POST", `${base}/polls/${p.id}/open`, { to });
      if (/^\/p\/[A-Za-z0-9_-]{22}(\/edit)?$/.test(r.redirect)) location.assign(r.redirect);
    } catch (e) {
      message = notice("error", e instanceof ApiError ? e.message : "開けませんでした。");
      draw();
    } finally {
      busy = false;
    }
  }

  async function remove(p: MinePoll): Promise<void> {
    if (busy) return;
    if (!confirm(`「${p.title ?? "（タイトル未入力）"}」を削除します。候補・回答などのデータはすぐに消え、元に戻せません。よろしいですか？`)) return;
    busy = true;
    try {
      const r = await request<{ warnings?: string[] }>("DELETE", `${base}/polls/${p.id}`, {});
      polls = polls.filter((x) => x.id !== p.id);
      message = notice(r.warnings?.length ? "warn" : "ok", `「${p.title ?? "（タイトル未入力）"}」を削除しました。`, ...(r.warnings ?? []).map((w) => h("p", {}, w)));
    } catch (e) {
      message = notice("error", e instanceof ApiError ? e.message : "削除できませんでした。");
    } finally {
      busy = false;
      draw();
    }
  }

  function item(p: MinePoll): HTMLElement {
    const info: (string | HTMLElement)[] = [];
    if (p.fixed) info.push(`確定: ${formatSlot(p.fixed, tz)}`);
    else if (p.deadlineAt && p.status !== "draft") info.push(`締切: ${dateTimeText(p.deadlineAt, tz)}`);
    if (p.status !== "draft") info.push(`回答 ${p.answered} / ${p.participants} 名`);
    info.push(`更新: ${dateTimeText(p.updatedAt, tz)}`);
    return h(
      "li",
      { class: "card mine-item" },
      h(
        "div",
        { class: "mine-head" },
        h("span", { class: `badge badge-status badge-${p.status}` }, STATUS_LABEL[p.status] ?? p.status),
        h("h2", { class: "mine-title" }, p.title ?? "（タイトル未入力）"),
      ),
      h("p", { class: "muted small mine-info" }, ...info.map((t) => h("span", {}, t))),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "btn btn-primary btn-small", onClick: () => void open(p, "edit") }, "編集"),
        p.status !== "draft" ? h("button", { type: "button", class: "btn btn-secondary btn-small", onClick: () => void open(p, "summary") }, "集計") : null,
        p.messageUrl ? h("a", { class: "btn btn-secondary btn-small", href: p.messageUrl, rel: "noopener noreferrer" }, "募集メッセージ") : null,
        h("button", { type: "button", class: "btn btn-danger btn-small mine-delete", onClick: () => void remove(p) }, "削除"),
      ),
    );
  }

  function draw(): void {
    setTitle("自分の調整");
    const shown = polls.filter((p) => filter === "all" || p.status === filter);
    const count = (f: Filter) => (f === "all" ? polls.length : polls.filter((p) => p.status === f).length);
    render(
      document.getElementById("app")!,
      h(
        "section",
        { class: "page" },
        h("h1", {}, "自分の調整"),
        h("p", { class: "muted" }, "このサーバーであなたが主催している調整の一覧です。他の人には見えません。"),
        message,
        h(
          "div",
          { class: "row mine-filter", role: "group", aria: { label: "状態で絞り込む" } },
          ...FILTERS.map(([f, label]) =>
            h(
              "button",
              {
                type: "button",
                class: `btn btn-small ${filter === f ? "btn-primary" : "btn-secondary"}`,
                aria: { pressed: String(filter === f) },
                onClick: () => {
                  filter = f;
                  message = null;
                  draw();
                },
              },
              `${label}（${count(f)}）`,
            ),
          ),
        ),
        shown.length
          ? h("ul", { class: "mine-list" }, ...shown.map(item))
          : h("p", { class: "muted" }, polls.length ? "この状態の調整はありません。" : "このサーバーであなたが主催している調整はありません。Discord で /schedule を実行すると作成できます。"),
        h("p", { class: "muted small" }, "削除した調整は元に戻せません。何も入力していない下書きは 3 日、公開した調整は締切（確定した場合は確定した日時）から 6 ヶ月で自動的に削除されます。"),
      ),
    );
  }

  draw();
}
