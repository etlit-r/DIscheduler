// S7: 公開完了・確定完了（docs/design.md §6.3, §4.3, §6.10）
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
  const kind = new URLSearchParams(location.search).get("kind") === "fixed" ? "fixed" : "published";
  let warnings: string[] = [];
  try {
    warnings = JSON.parse(sessionStorage.getItem("dis.warnings") ?? "[]") as string[];
    sessionStorage.removeItem("dis.warnings");
  } catch {
    /* 無視 */
  }
  setTitle(kind === "fixed" ? "確定しました" : "公開しました");
  render(
    document.getElementById("app")!,
    h(
      "section",
      { class: "page done" },
      h("h1", {}, kind === "fixed" ? "日時を確定しました" : "チャンネルに募集を投稿しました"),
      h("p", {}, d.poll.title ?? ""),
      kind === "fixed"
        ? h("p", {}, "確定のお知らせをチャンネルに投稿しました。確定後も参加者は回答を変更でき、変更があれば集計画面に表示されます。")
        : h("p", {}, "参加者は募集メッセージの［回答する］から回答できます。集計は集計画面でいつでも見られます。"),
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
            h("a", { href: d.donationUrl, rel: "noopener noreferrer" }, "運営を支援する"),
            "（任意です。支援の有無で機能は変わりません）",
          )
        : null,
    ),
  );
}
