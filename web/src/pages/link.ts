// S1: リンク中継（docs/design.md §6.8）
// トークンは URL フラグメントにあるので、サーバーのログや Referer には残らない。
// 読み取ったらすぐに URL から消し、POST でセッションに交換する。
import { request } from "../api";
import { showError } from "../common";

export async function linkPage(): Promise<void> {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  history.replaceState(null, "", "/l");
  if (!m) {
    showError(Object.assign(new Error("リンクが正しくありません。"), { status: 401, code: "bad_link" }));
    return;
  }
  try {
    const res = await request<{ redirect: string }>("POST", "/api/session", { token: m[1] });
    if (/^\/p\/[A-Za-z0-9_-]{22}(\/(edit|answer))?$/.test(res.redirect)) location.replace(res.redirect);
    else throw new Error("不正な応答です。");
  } catch (e) {
    showError(e);
  }
}
