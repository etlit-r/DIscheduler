// Web API の呼び出し
import type { ChoiceColor, ChoiceKind, PollStatus, Role } from "../../../src/shared/model";
import { LANG, tr } from "./i18n";

export interface PollData {
  now: number;
  csrfToken: string;
  donationUrl: string | null;
  poll: {
    id: string;
    title: string | null;
    description: string | null;
    status: PollStatus;
    deadlineAt: number | null;
    timezone: string;
    timezoneSet: boolean;
    targetType: "channel" | "role" | "manual";
    targetId: string | null;
    joinPolicy: "closed" | "open";
    choicesVersion: number;
    updatedAt: number;
    messageUrl: string | null;
    lastSyncedAt: number | null;
    pendingChanges: number | null;
    nextAutoSyncAt: number | null;
    choicesChangedAt: number | null;
    /** 予定のリマインドを当日（0）か前日（1）の何時（remindHour。調整のタイムゾーン）に送るか（§5.7） */
    remindDayOffset: number;
    remindHour: number;
  };
  me: { userId: string; role: Role; isParticipant: boolean; displayName: string | null; comment: string | null; answeredAt: number | null; needsChoicesAck: boolean };
  /** fixedAt: 確定した時刻（未確定なら null。複数の候補を確定できる）。hasEvent: この候補で Discord イベントを登録済みか。announced: 前回の［確定をお知らせする］で確定日として知らせたか */
  slots: { id: string; startAt: number; endAt: number | null; allDay: boolean; fixedAt: number | null; hasEvent: boolean; announced: boolean }[];
  choices: { id: string; symbol: string; label: string; kind: ChoiceKind; score: number; color: ChoiceColor }[];
  participants: { userId: string; displayName: string; comment: string | null; answeredAt: number | null }[];
  answers: { slotId: string; userId: string; choiceId: string; prevChoiceId: string | null; updatedAt: number }[];
  /** サーバーで最近使った時間帯（新しい順・最大 3 件）。主催者にだけ返る */
  recentTimes: { start: string; end: string }[];
  /** サーバーの既定値の、Discord イベントの場所（主催者にだけ返る。null なら「Discord」） */
  defaultEventLocation: string | null;
  /** サーバーの既定値の、Discord イベントのボイスチャンネル（主催者にだけ返る）。入っていれば確定の画面で最初から選ぶ */
  defaultEventChannelId: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 日本語と英語の両方の文言（あれば、画面の言語を切り替えたときにこちらを使う。§6.12） */
    readonly texts: { ja: string; en: string } | null = null,
  ) {
    super(message);
  }

  /** いまの画面の言語での文言 */
  text(): string {
    return this.texts ? this.texts[LANG] : this.message;
  }
}

/** 日本語と英語の両方を持つエラーを作る（画面の中で作るエラー） */
export function apiError(status: number, code: string, ja: string, en: string): ApiError {
  return new ApiError(status, code, tr(ja, en), { ja, en });
}

let csrfToken = "";
export function setCsrf(token: string): void {
  csrfToken = token;
}

/** 失敗した操作の名前（エラーの文に添えて、どの段階で失敗したかを利用者から聞けるようにする） */
const OPERATIONS: [string, RegExp, string, string][] = [
  ["PATCH", /^\/api\/polls\/[^/]+$/, "基本情報の保存", "saving the poll details"],
  ["PUT", /\/slots$/, "候補の保存", "saving the dates"],
  ["PUT", /\/choices$/, "選択肢の保存", "saving the answer options"],
  ["PUT", /\/participants$/, "参加者の保存", "saving the participants"],
  ["POST", /\/publish$/, "公開", "publishing"],
  ["PUT", /\/answers\/me$/, "回答の保存", "saving your answer"],
  ["POST", /\/fix$/, "日程の確定", "fixing the date"],
  ["DELETE", /\/fix\/[^/]+$/, "確定の取り消し", "unfixing the date"],
  ["POST", /\/announce$/, "確定のお知らせ", "announcing the dates"],
  ["POST", /\/sync-message$/, "募集メッセージの更新", "refreshing the poll message"],
  ["POST", /\/repost$/, "募集メッセージの出し直し", "reposting the poll message"],
  ["POST", /\/remind$/, "リマインド", "sending the reminder"],
  ["POST", /\/renotify$/, "再通知", "re-notifying"],
  ["DELETE", /^\/api\/(polls|guilds\/[^/]+\/polls)\/[^/]+$/, "調整の削除", "deleting the poll"],
  ["GET", /^\/api\/polls\/[^/]+$/, "調整の読み込み", "loading the poll"],
];

function operationName(method: string, path: string): { ja: string; en: string } | null {
  const p = path.split("?")[0]!;
  const hit = OPERATIONS.find(([m, re]) => m === method && re.test(p));
  return hit ? { ja: hit[2], en: hit[3] } : null;
}

/** DIscheduler の JSON でない失敗（Cloudflare のエラーページなど）の文。状態コード・時刻・Ray ID を添える */
function unexpectedResponseError(method: string, path: string, status: number, ray: string | null): ApiError {
  const op = operationName(method, path);
  const d = new Date();
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const rayJa = ray ? `・Ray ID: ${ray}` : "";
  const rayEn = ray ? `, Ray ID: ${ray}` : "";
  return apiError(
    status,
    "error",
    `${op ? `${op.ja}で` : ""}エラーが発生しました（HTTP ${status}・${time}${rayJa}）。時間をおいてもう一度お試しください。`,
    `Something went wrong${op ? ` while ${op.en}` : ""} (HTTP ${status}, ${time}${rayEn}). Please try again later.`,
  );
}

// --- 利用者には直せないエラーの知らせ（§12 の監視） ---
// Cloudflare が途中で打ち切った応答や、画面のプログラムの不具合は、サーバーのログに残らないので、画面からサーバーに知らせて error_logs に残す。
// 知らせる先は、セッションのある画面（調整の画面と、主催者の調整一覧）の API だけ（セッションの Cookie が要る）。
// 送れなかった分は、次に成功したリクエストのあとに送り直す（3 回届かなければ諦める）。
// 利用者が自分で直せるもの（通信の切断、入力の誤り、リンクの期限切れなど、サーバーが理由を返したもの）は知らせない

type ClientErrorReport =
  | { kind: "http"; status: number; method: string; path: string; at: number; ray: string | null }
  | { kind: "script"; message: string; where: string | null; at: number };

const pendingReports: { body: ClientErrorReport; tries: number }[] = [];
/** 1 つの画面で知らせる数の上限（同じ不具合が繰り返し起きても、送りすぎないように） */
const REPORT_MAX = 10;
let reportCount = 0;
const reported = new Set<string>();

/** 知らせる先（いまの画面のセッションの API）。セッションのない画面（リンク中継など）では null */
function reportEndpoint(): string | null {
  const p = /^\/p\/([A-Za-z0-9_-]{22})(\/|$)/.exec(location.pathname);
  if (p) return `/api/polls/${p[1]}/client-errors`;
  const g = /^\/g\/(\d{17,20})\/polls\/?$/.exec(location.pathname);
  if (g) return `/api/guilds/${g[1]}/client-errors`;
  return null;
}

/** API のパスの ID を伏せる（調整・候補の ID は :id、数字の ID は :n。問い合わせの文字列は除く） */
export function maskApiPath(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((seg) => (/^[A-Za-z0-9_-]{22}$/.test(seg) ? ":id" : /^\d+$/.test(seg) ? ":n" : seg))
    .join("/");
}

function queueReport(body: ClientErrorReport): void {
  if (!reportEndpoint() || reportCount >= REPORT_MAX) return;
  const key = body.kind === "http" ? `${body.method} ${body.path} ${body.status}` : `${body.message} ${body.where}`;
  if (reported.has(key)) return;
  reported.add(key);
  reportCount++;
  pendingReports.push({ body, tries: 0 });
  void flushReports();
}

function queueHttpReport(method: string, path: string, status: number, ray: string | null): void {
  if (path.includes("/client-errors") || status < 100 || status > 599) return;
  const r = ray && /^[0-9a-f]{16}(-[A-Z]{3})?$/.test(ray) ? ray : null;
  queueReport({ kind: "http", status, method, path: maskApiPath(path), at: Math.floor(Date.now() / 1000), ray: r });
}

/**
 * 画面のプログラムの不具合（予期しない例外）を知らせる。
 * サーバーが理由を返したエラー（ApiError）は、利用者に理由を見せているので知らせない（JSON でない応答は request が知らせる）。
 * 位置は、画面のプログラム（/app/assets/）の中のものだけを送る（拡張機能などの、ほかのスクリプトのエラーは送らない）
 */
export function reportScriptError(e: unknown): void {
  if (e instanceof ApiError) return;
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "string" ? e : "non-error value thrown";
  // eslint-disable-next-line no-control-regex
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "unknown";
  const stack = e instanceof Error ? (e.stack ?? "") : "";
  const m = /\/app\/assets\/[A-Za-z0-9._-]+\.js:\d{1,7}:\d{1,7}/.exec(stack);
  queueReport({ kind: "script", message, where: m ? m[0] : null, at: Math.floor(Date.now() / 1000) });
}

let flushing = false;
async function flushReports(): Promise<void> {
  const url = reportEndpoint();
  if (flushing || !url) return;
  flushing = true;
  try {
    while (pendingReports.length > 0) {
      const report = pendingReports[0]!;
      if (report.tries >= 3) {
        pendingReports.shift();
        continue;
      }
      report.tries++;
      const res = await fetch(url, {
        method: "POST",
        // 最初の読み込みに失敗したときは CSRF のトークンがまだないので、なくても受け付ける（サーバーは Origin とセッションで確かめる）
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
        body: JSON.stringify(report.body),
        credentials: "same-origin",
        cache: "no-store",
      }).catch(() => null);
      // 届かなかった（通信の失敗・5xx・Cloudflare に止められた 403）なら、次に成功したリクエストのあとに送り直す。
      // それ以外（記録できた・入力が正しくないなどで断られた）は、知らせを消す
      if (!res || res.status >= 500 || res.status === 403) break;
      pendingReports.shift();
    }
  } finally {
    flushing = false;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // エラーの文言を画面の言語で受け取る（§6.12）
  const headers: Record<string, string> = { Accept: "application/json", "X-DI-Lang": LANG };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw apiError(0, "network", "通信できませんでした。接続を確認してもう一度お試しください。", "Couldn't connect. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; messages?: { ja: string; en: string } } } | null;
  if (!res.ok) {
    const err = data?.error;
    if (!err?.message) {
      const ray = res.headers.get("cf-ray");
      queueHttpReport(method, path, res.status, ray);
      throw unexpectedResponseError(method, path, res.status, ray);
    }
    const texts = err.messages && typeof err.messages.ja === "string" && typeof err.messages.en === "string" ? err.messages : null;
    throw new ApiError(res.status, err.code ?? "error", err.message, texts);
  }
  if (pendingReports.length > 0) void flushReports();
  return data as T;
}

export async function loadPoll(pollId: string): Promise<PollData> {
  const d = await request<PollData>("GET", `/api/polls/${pollId}`);
  setCsrf(d.csrfToken);
  return d;
}
