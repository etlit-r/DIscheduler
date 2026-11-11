// 回答の完了画面の［集計画面を見る］（docs/design.md §6.4）
// 調整の ID はアドレスの # の後ろ（#p=...）から読む。形式が正しいときだけボタンを出す
// CSP（Trusted Types）を守るため、innerHTML などは使わず属性だけを設定する
(() => {
  const id = new URLSearchParams(location.hash.slice(1)).get("p");
  const btn = document.getElementById("to-summary");
  if (!btn || !id || !/^[A-Za-z0-9_-]{22}$/.test(id)) return;
  btn.setAttribute("href", `/p/${id}`);
  btn.hidden = false;
})();
