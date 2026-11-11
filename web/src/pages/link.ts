// S1: リンク中継（docs/design.md §6.8）
// トークンは URL フラグメントにあるので、サーバーのログや Referer には残らない。
// 読み取ったらすぐに URL から消し、POST でセッションに交換する。
import { ApiError, request } from "../lib/api";
import { showError } from "../ui/common";

export async function linkPage(): Promise<void> {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  history.replaceState(null, "", "/l");
  if (!m) {
    // エラー表示（showError）は ApiError だけを受け付けるので、ApiError で渡す
    showError(new ApiError(401, "bad_link", "リンクが正しくないか、一部が欠けています。"));
    return;
  }
  try {
    const res = await request<{ redirect: string }>("POST", "/api/session", { token: m[1] });
    if (/^\/p\/[A-Za-z0-9_-]{22}(\/(edit|answer))?$/.test(res.redirect) || /^\/g\/\d{17,20}\/polls$/.test(res.redirect)) location.replace(res.redirect);
    else throw new ApiError(500, "bad_response", "エラーが発生しました。Discord からもう一度リンクを開いてください。");
  } catch (e) {
    showError(e);
  }
}
