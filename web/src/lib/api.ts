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

// --- 画面で受け取った失敗の知らせ（§12 の監視） ---
// Cloudflare が途中で打ち切った応答はアプリのログに残らないので、画面からサーバーに知らせて error_logs に残す。
// 知らせる先は調整の画面の API だけ（セッションと CSRF のトークンが要る）。送れなかった分は、次に成功したリクエストのあとに送り直す

interface ClientErrorReport {
  pollId: string;
  status: number;
  method: string;
  path: string;
  at: number;
  ray: string | null;
  /** 送ろうとした回数（3 回届かなければあきらめる） */
  tries: number;
}

const pendingReports: ClientErrorReport[] = [];
const PENDING_MAX = 5;

/** API のパスの ID を伏せる（調整・候補の ID は :id、数字の ID は :n。問い合わせの文字列は除く） */
export function maskApiPath(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((seg) => (/^[A-Za-z0-9_-]{22}$/.test(seg) ? ":id" : /^\d+$/.test(seg) ? ":n" : seg))
    .join("/");
}

function queueReport(method: string, path: string, status: number, ray: string | null): void {
  const m = /^\/api\/polls\/([A-Za-z0-9_-]{22})(\/|$|\?)/.exec(path);
  if (!m || path.includes("/client-errors")) return;
  if (pendingReports.length >= PENDING_MAX) return;
  const r = /^[0-9a-f]{16}(-[A-Z]{3})?$/.test(ray ?? "") ? ray : null;
  pendingReports.push({ pollId: m[1]!, status, method, path: maskApiPath(path), at: Math.floor(Date.now() / 1000), ray: r, tries: 0 });
}

let flushing = false;
async function flushReports(): Promise<void> {
  if (flushing || !csrfToken) return;
  flushing = true;
  try {
    while (pendingReports.length > 0) {
      const report = pendingReports[0]!;
      if (report.tries >= 3) {
        pendingReports.shift();
        continue;
      }
      report.tries++;
      const { pollId, tries: _tries, ...body } = report;
      const res = await fetch(`/api/polls/${pollId}/client-errors`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(body),
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
    queueReport(method, path, 0, null);
    void flushReports();
    throw apiError(0, "network", "通信できませんでした。接続を確認してもう一度お試しください。", "Couldn't connect. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; messages?: { ja: string; en: string } } } | null;
  if (!res.ok) {
    const err = data?.error;
    if (!err?.message) {
      const ray = res.headers.get("cf-ray");
      queueReport(method, path, res.status, ray);
      void flushReports();
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
