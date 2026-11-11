// 回答の完了画面の［回答画面に戻る］（docs/design.md §6.4）
// 調整の ID はアドレスの # の後ろ（#p=...）から読む。形式が正しいときだけボタンを出す
// CSP（Trusted Types）を守るため、innerHTML などは使わず属性だけを設定する
(() => {
  const id = new URLSearchParams(location.hash.slice(1)).get("p");
  const btn = document.getElementById("back-to-answer");
  if (!btn || !id || !/^[A-Za-z0-9_-]{22}$/.test(id)) return;
  btn.setAttribute("href", `/p/${id}/answer`);
  btn.hidden = false;
})();
