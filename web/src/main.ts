import "./app.css";
import { ApiError } from "./lib/api";
import { showError } from "./ui/common";
import { answerPage } from "./pages/answer";
import { donePage } from "./pages/done";
import { editPage } from "./pages/edit";
import { linkPage } from "./pages/link";
import { summaryPage } from "./pages/summary";

async function route(): Promise<void> {
  const path = location.pathname;
  if (path === "/l") return linkPage();
  const m = /^\/p\/([A-Za-z0-9_-]{22})(?:\/(edit|answer|done))?\/?$/.exec(path);
  if (!m) return showError(new ApiError(404, "not_found", "ページが見つかりません。"));
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

route().catch(showError);
