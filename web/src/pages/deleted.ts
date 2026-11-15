// 調整の削除の完了（docs/design.md §6.11）。
// 作成画面で削除したとき、同じブラウザに一覧のセッションがなければこの画面を出す（あれば一覧に戻る）。
// アドレスは /p/{id}/deleted に変えるので、再読み込みしてもこの画面のまま（調整はもうないので、API は呼ばない）
import { donationLine } from "../ui/common";
import { h, notice, render, setTitle } from "../lib/dom";
import { staticHref, tr } from "../lib/i18n";

/** 削除できたときの知らせ（一覧の画面と同じ文言） */
export function deletedText(): string {
  return tr("調整が正常に削除されました。", "The poll was deleted successfully.");
}

export function deletedPage(opts: { warnings?: string[]; donationUrl?: string | null } = {}): void {
  setTitle(tr("調整を削除しました", "Poll deleted"));
  render(
    document.getElementById("app")!,
    h(
      "section",
      { class: "page" },
      h("h1", {}, tr("調整を削除しました", "Poll deleted")),
      notice("ok", deletedText()),
      ...(opts.warnings ?? []).map((w) => notice("warn", w)),
      h(
        "p",
        {},
        tr(
          "作成した調整の一覧は、Discord で /schedule を実行し、［作成した調整を管理］を押すと開けます。",
          "To see the polls you created, run /schedule in Discord and press [Manage my polls].",
        ),
      ),
      h("p", {}, h("a", { href: staticHref("/manual/", "/en/manual/") }, tr("DIscheduler のマニュアルへ", "Go to the DIscheduler manual"))),
      donationLine(opts.donationUrl ?? null),
    ),
  );
}

/** 一覧に戻ったときに出す知らせ（削除のときの注意）を、一覧の画面へ渡す。保存できないブラウザでは注意は渡さない */
const KEY = "dis.deletedWarnings";
export function passDeletedWarnings(warnings: string[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(warnings));
  } catch {
    /* 無視 */
  }
}
export function takeDeletedWarnings(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown;
    sessionStorage.removeItem(KEY);
    return Array.isArray(v) ? v.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}
