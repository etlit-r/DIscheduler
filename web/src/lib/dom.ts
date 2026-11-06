// DOM を組み立てる小さな道具。
// XSS 対策のため、文字列は textContent でしか入れない（innerHTML などは使わない。security-design §4.4）

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  id?: string;
  type?: string;
  value?: string;
  name?: string;
  href?: string;
  for?: string;
  role?: string;
  title?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  required?: boolean;
  hidden?: boolean;
  min?: string;
  max?: string;
  maxLength?: number;
  rows?: number;
  autocomplete?: string;
  rel?: string;
  open?: boolean;
  scope?: string;
  colSpan?: number;
  aria?: Record<string, string>;
  data?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onSubmit?: (e: SubmitEvent) => void;
};

const SAFE_URL = /^(https:\/\/|\/(?!\/)|#)/;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    switch (k) {
      case "class":
        el.className = String(v);
        break;
      case "aria":
        for (const [ak, av] of Object.entries(v as Record<string, string>)) el.setAttribute(`aria-${ak}`, av);
        break;
      case "data":
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
        break;
      case "href":
        // javascript: などの URL は入れない
        if (SAFE_URL.test(String(v))) el.setAttribute("href", String(v));
        break;
      case "onClick":
        el.addEventListener("click", v as EventListener);
        break;
      case "onInput":
        el.addEventListener("input", v as EventListener);
        break;
      case "onChange":
        el.addEventListener("change", v as EventListener);
        break;
      case "onSubmit":
        el.addEventListener("submit", v as EventListener);
        break;
      case "for":
        el.setAttribute("for", String(v));
        break;
      case "value":
        (el as HTMLInputElement).value = String(v);
        break;
      case "checked":
      case "selected":
      case "disabled":
      case "required":
      case "hidden":
      case "open":
        (el as unknown as Record<string, boolean>)[k] = Boolean(v);
        break;
      case "maxLength":
      case "rows":
      case "colSpan":
        (el as unknown as Record<string, number>)[k] = Number(v);
        break;
      default:
        el.setAttribute(k, String(v));
    }
  }
  append(el, ...children);
  return el;
}

export function append(el: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function render(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, ...children);
}

/** 画面上部のお知らせ（読み上げにも伝える） */
export function notice(kind: "info" | "ok" | "warn" | "error", ...children: Child[]): HTMLElement {
  return h("div", { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" }, ...children);
}

export function setTitle(t: string): void {
  document.title = t ? `${t}｜DIscheduler` : "DIscheduler";
}
