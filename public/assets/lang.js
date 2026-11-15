// 静的ページ（トップ・マニュアル・セキュリティ方針・回答の完了画面）の言語（docs/design.md §6.12）
// - 英語版は /en/ の下にある。各ページの右上の切り替え（a[data-lang]）で、もう一方の言語のページへ移る
// - 切り替えで選んだ言語は、このブラウザの localStorage（dis.lang。Web 画面と共通）にだけ保存する
// - 選んだ言語がまだなければ、ブラウザの言語（日本語なら日本語、それ以外は英語）のページへ移る。
//   検索エンジンのクローラーは移さない（日本語版と英語版のどちらも、それぞれのアドレスで読まれるように）
// - 広告の枠（ad-consent.js）より先に読み込む。別の言語のページへ移るときは、広告の枠を読み込ませない（data-lang-redirect）
(() => {
  const KEY = "dis.lang";
  const page = document.documentElement.lang === "en" ? "en" : "ja";
  const store = (v) => {
    try {
      localStorage.setItem(KEY, v);
      return true;
    } catch {
      return false;
    }
  };
  const link = document.querySelector("a[data-lang]");
  if (!link) return;
  // もう一方の言語のページのアドレスは、リンクの属性からではなく今のページのアドレスから組み立てる
  // （ページの中の文字をそのままリンクに入れないため。英語版は /en/ の下に同じ構成で置いている）
  const target = page === "en" ? "ja" : "en";
  const here = location.pathname.replace(/[^A-Za-z0-9_\-./]/g, "");
  const base = page === "en" ? here.replace(/^\/en(\/|$)/, "/") : `/en${here}`;
  const withLang = (path, lang) => `${path}${path.includes("?") ? "&" : "?"}lang=${lang}`;
  // URL の ?lang= ＞ このブラウザで選んだ言語 ＞ ブラウザの言語（Web 画面と同じ）
  const q = new URLSearchParams(location.search).get("lang");
  const fromUrl = q === "ja" || q === "en" ? q : null;
  // 保存できないと分かったブラウザ（noStore）では、サイト内のリンクと元のページのアドレスにも ?lang= を付ける
  let noStore = fromUrl !== null && !store(fromUrl);
  const isBot = () => navigator.webdriver || /bot|crawl|spider|slurp|preview/i.test(navigator.userAgent);
  // 保存できたら、アドレス欄から ?lang= を外す（共有したアドレスで、相手の言語を決めてしまわないように）
  if (fromUrl !== null && !noStore) {
    try {
      const here = new URL(location.href);
      here.searchParams.delete("lang");
      history.replaceState(history.state, "", here.href);
    } catch {
      // 外せなくても、言語は保存できている
    }
  }
  // # の後ろ（回答の完了画面の #p=、ページ内の見出し）は、もう一方の言語のページでも保つ。
  // ページ内の見出しへ移ったあとでも保てるよう、今の # を使う
  // アドレス欄の # はだれでも書き換えられるので、見出しの名前と #p= に使う文字（英数字と _ - . = &）だけを残してからリンクに入れる
  const safeHash = () => {
    const h = location.hash.slice(1).replace(/[^A-Za-z0-9_\-.=&]/g, "");
    return h ? `#${h}` : "";
  };
  const withHash = (path) => path + safeHash();
  // 切り替えのリンクには ?lang= を付ける。新しいタブで開くとき（右クリックのメニューや中クリック）はクリックの処理を通らず
  // 言語を保存できないので、移った先で保存した言語やブラウザの言語のページへ戻されないように。クローラーには付けない
  const sync = () =>
    link.setAttribute("href", withHash(isBot() ? base : withLang(base, target)));
  sync();
  // 新しいタブで開くとき（クリックの処理を通らない）も、今の # を使う
  window.addEventListener("hashchange", sync);
  link.addEventListener("click", () => {
    const lang = target;
    if (!store(lang) && !noStore) {
      // 保存できないブラウザでは ?lang= で選んだ言語を伝える（移った先で、ブラウザの言語のページへ戻されないように）。
      // 戻るでこのページへ戻ったときも、このページの言語のままにする
      noStore = true;
      try {
        const here = new URL(location.href);
        here.searchParams.set("lang", page);
        history.replaceState(history.state, "", here.href);
      } catch {
        // 書き換えられなくても、移る先には言語を伝える
      }
    }
    sync();
  });

  let want;
  if (fromUrl) want = fromUrl;
  else {
    let saved = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      saved = null;
    }
    if (saved === "ja" || saved === "en") want = saved;
    else {
      if (isBot()) return;
      const first = (navigator.languages && navigator.languages[0]) || navigator.language || "";
      want = /^ja(\b|-|_|$)/i.test(first) ? "ja" : "en";
    }
  }
  if (want === page) {
    if (noStore) {
      // 保存できないブラウザでは、同じサイトの中のリンクにも ?lang= を付けて、次のページでも言語を保つ
      for (const a of document.querySelectorAll('a[href^="/"]:not([href^="//"]):not([data-lang])')) {
        // リンクの文字をそのまま使わず、パスと # の後ろを決まった文字だけにしてから組み立て直す
        if (a.search) continue;
        const path = a.pathname.replace(/[^A-Za-z0-9_\-./]/g, "");
        const hash = a.hash.slice(1).replace(/[^A-Za-z0-9_\-.=&]/g, "");
        a.setAttribute("href", `${withLang(path, page)}${hash ? `#${hash}` : ""}`);
      }
    }
    return;
  }
  // 検索エンジンのクローラーと自動操作のブラウザは、?lang= があっても移さない
  if (fromUrl && isBot()) return;
  // もう一方の言語のページへ移る（# の後ろはそのまま保つ。回答の完了画面の #p= など）
  document.documentElement.setAttribute("data-lang-redirect", "");
  location.replace(withHash(fromUrl ? withLang(base, fromUrl) : base));
})();
