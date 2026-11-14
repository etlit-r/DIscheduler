import "./app.css";
import { ApiError } from "./lib/api";
import { showError } from "./ui/common";
import { answerPage } from "./pages/answer";
import { donePage } from "./pages/done";
import { editPage } from "./pages/edit";
import { linkPage } from "./pages/link";
import { minePage } from "./pages/mine";
import { summaryPage } from "./pages/summary";
import { LANG, setLang, tr } from "./lib/i18n";

/** 画面の枠（index.html）の文言と言語を、画面の言語に合わせる（§6.12） */
function setupShell(): void {
  document.documentElement.lang = LANG;
  const skip = document.getElementById("skip-link");
  if (skip) skip.textContent = tr("本文へ移動", "Skip to content");
  const loading = document.querySelector(".loading");
  if (loading) loading.textContent = tr("読み込んでいます…", "Loading…");
  const security = document.getElementById("footer-security");
  if (security) security.textContent = tr("セキュリティ方針", "Security policy");
  // 言語の切り替え。もう一方の言語の名前を、その言語で書く
  const sw = document.getElementById("lang-switch");
  if (sw) {
    const other = LANG === "en" ? "ja" : "en";
    sw.textContent = other === "en" ? "English" : "日本語";
    sw.setAttribute("lang", other);
    sw.setAttribute("aria-label", other === "en" ? "Switch to English" : "日本語に切り替える");
    sw.hidden = false;
    sw.addEventListener("click", () => setLang(other));
  }
}

async function route(): Promise<void> {
  const path = location.pathname;
  if (path === "/l") return linkPage();
  const g = /^\/g\/(\d{17,20})\/polls\/?$/.exec(path);
  if (g) return minePage(g[1]!);
  const m = /^\/p\/([A-Za-z0-9_-]{22})(?:\/(edit|answer|done))?\/?$/.exec(path);
  if (!m) return showError(new ApiError(404, "not_found", tr("ページが見つかりません。", "Page not found.")));
  const id = m[1]!;
  switch (m[2]) {
    case "edit":
      return editPage(id);
    case "answer":
      return answerPage(id);
    case "done":
      return donePage(id);
    default:
      return summaryPage(id);
  }
}

setupShell();
route().catch(showError);
