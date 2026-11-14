// S7: 公開完了（docs/design.md §6.3, §6.10）。確定は集計画面の中で完了を知らせる（§4.3）
import { loadPoll } from "../lib/api";
import { donationLine, rememberDonation, showError } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { tr } from "../lib/i18n";

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
  setTitle(tr("公開しました", "Published"));
  render(
    document.getElementById("app")!,
    h(
      "section",
      { class: "page done" },
      h("h1", {}, tr("チャンネルに募集を投稿しました", "The poll was posted to the channel")),
      h("p", {}, d.poll.title ?? ""),
      h("p", {}, tr("参加者は募集メッセージの［回答する］から回答できます。集計は集計画面でいつでも見られます。", "Participants can answer from [Answer] on the poll message. You can view the results on the results page at any time.")),
      ...warnings.filter((w) => typeof w === "string").map((w) => notice("warn", w)),
      h(
        "div",
        { class: "row" },
        h("a", { class: "btn btn-primary", href: `/p/${pollId}` }, tr("集計画面を開く", "Open the results page")),
        d.poll.messageUrl ? h("a", { class: "btn btn-secondary", href: d.poll.messageUrl, rel: "noopener noreferrer" }, tr("募集メッセージを開く", "Open the poll message")) : null,
      ),
      donationLine(d.donationUrl),
    ),
  );
}
