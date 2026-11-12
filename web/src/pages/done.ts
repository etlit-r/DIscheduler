// S7: 公開完了（docs/design.md §6.3, §6.10）。確定は集計画面の中で完了を知らせる（§4.3）
import { loadPoll } from "../lib/api";
import { rememberDonation, showError } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";

export async function donePage(pollId: string): Promise<void> {
  let d;
  try {
    d = await loadPoll(pollId);
  } catch (e) {
    return showError(e, "done");
  }
  rememberDonation(d.donationUrl);
  let warnings: string[] = [];
  try {
    warnings = JSON.parse(sessionStorage.getItem("dis.warnings") ?? "[]") as string[];
    sessionStorage.removeItem("dis.warnings");
  } catch {
    /* 無視 */
  }
  setTitle("公開しました");
  render(
    document.getElementById("app")!,
    h(
      "section",
      { class: "page done" },
      h("h1", {}, "チャンネルに募集を投稿しました"),
      h("p", {}, d.poll.title ?? ""),
      h("p", {}, "参加者は募集メッセージの［回答する］から回答できます。集計は集計画面でいつでも見られます。"),
      ...warnings.filter((w) => typeof w === "string").map((w) => notice("warn", w)),
      h(
        "div",
        { class: "row" },
        h("a", { class: "btn btn-primary", href: `/p/${pollId}` }, "集計画面を開く"),
        d.poll.messageUrl ? h("a", { class: "btn btn-secondary", href: d.poll.messageUrl, rel: "noopener noreferrer" }, "募集メッセージを開く") : null,
      ),
      d.donationUrl
        ? h(
            "p",
            { class: "donation-line" },
            "DIscheduler は無料で運営しています。役に立ったら ",
            h("a", { href: d.donationUrl, rel: "noopener noreferrer" }, "☕ コーヒーを 1 杯おごる"),
            "（Ko-fi。任意です。支援の有無で機能は変わりません）",
          )
        : null,
    ),
  );
}
