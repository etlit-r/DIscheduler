// 認証・署名検証・権限判定の境界を確かめる（Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  consumeLink,
  consumeListLink,
  createListSession,
  createSession,
  getListSession,
  getSession,
  issueLink,
  issueListLink,
  LINK_TTL,
  listSessionCookie,
  lookupLinkKind,
  readCookie,
  SESSION_TTL,
  sessionCookie,
} from "../src/auth";
import { hasPermission, PERM } from "../src/discord/permissions";
import { verifyDiscordRequest } from "../src/discord/verify";
import { nowSec } from "../src/core/lib";
import type { Env } from "../src/core/env";
import { GUILD, ORGANIZER, ORIGIN, seedPoll, tokenFromUrl } from "./helpers";

const db = () => (env as unknown as Env).DB;

describe("権限の判定", () => {
  it("指定の権限ビットを持っていれば true", () => {
    expect(hasPermission(String(PERM.MANAGE_GUILD), PERM.MANAGE_GUILD)).toBe(true);
    expect(hasPermission(String(PERM.VIEW_CHANNEL | PERM.MANAGE_GUILD), PERM.VIEW_CHANNEL)).toBe(true);
  });
  it("管理者は、どの権限でも true", () => {
    expect(hasPermission(String(PERM.ADMINISTRATOR), PERM.MANAGE_GUILD)).toBe(true);
  });
  it("別の権限しか持っていなければ false", () => {
    expect(hasPermission(String(PERM.VIEW_CHANNEL), PERM.MANAGE_GUILD)).toBe(false);
    expect(hasPermission("0", PERM.VIEW_CHANNEL)).toBe(false);
  });
  it("空・数字以外・前後に余計な文字があるものは false", () => {
    expect(hasPermission(undefined, PERM.VIEW_CHANNEL)).toBe(false);
    expect(hasPermission(null, PERM.VIEW_CHANNEL)).toBe(false);
    expect(hasPermission("", PERM.VIEW_CHANNEL)).toBe(false);
    expect(hasPermission("x1024", PERM.VIEW_CHANNEL)).toBe(false);
    expect(hasPermission("1024x", PERM.VIEW_CHANNEL)).toBe(false);
  });
});

describe("Discord の署名検証", () => {
  const toHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

  async function keyPair() {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = toHex((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
    return { kp, pub };
  }

  async function signed(kp: CryptoKeyPair, ts: string, body: string, headers: Record<string, string> = {}) {
    const sig = toHex(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(ts + body)));
    return new Request("https://example.test/interactions", {
      method: "POST",
      headers: { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts, ...headers },
      body,
    });
  }

  it("正しい署名なら本文を返す（大文字の 16 進数も受け付ける）", async () => {
    const { kp, pub } = await keyPair();
    const now = 1_800_000_000;
    expect(await verifyDiscordRequest(await signed(kp, String(now), '{"type":1}'), pub, now)).toBe('{"type":1}');
    expect(await verifyDiscordRequest(await signed(kp, String(now), "x"), pub.toUpperCase(), now)).toBe("x");
  });

  it("同じ公開鍵で続けて検証できる（鍵のキャッシュ）", async () => {
    const { kp, pub } = await keyPair();
    const now = 1_800_000_000;
    expect(await verifyDiscordRequest(await signed(kp, String(now), "a"), pub, now)).toBe("a");
    expect(await verifyDiscordRequest(await signed(kp, String(now), "b"), pub, now)).toBe("b");
  });

  it("別の鍵の署名・改ざんした本文は拒否する", async () => {
    const { kp, pub } = await keyPair();
    const other = await keyPair();
    const now = 1_800_000_000;
    expect(await verifyDiscordRequest(await signed(kp, String(now), "a"), other.pub, now)).toBeNull();
    const req = await signed(kp, String(now), "a");
    const tampered = new Request(req.url, { method: "POST", headers: req.headers, body: "b" });
    expect(await verifyDiscordRequest(tampered, pub, now)).toBeNull();
  });

  it("時刻のずれは ±300 秒まで受け付ける", async () => {
    const { kp, pub } = await keyPair();
    const now = 1_800_000_000;
    expect(await verifyDiscordRequest(await signed(kp, String(now - 300), "a"), pub, now)).toBe("a");
    expect(await verifyDiscordRequest(await signed(kp, String(now + 300), "a"), pub, now)).toBe("a");
    expect(await verifyDiscordRequest(await signed(kp, String(now - 301), "a"), pub, now)).toBeNull();
    expect(await verifyDiscordRequest(await signed(kp, String(now + 301), "a"), pub, now)).toBeNull();
  });

  it("ヘッダーが無い・形式が違うものは拒否する", async () => {
    const { kp, pub } = await keyPair();
    const now = 1_800_000_000;
    const good = await signed(kp, String(now), "a");
    const sig = good.headers.get("X-Signature-Ed25519")!;
    const mk = (h: Record<string, string>) => new Request("https://example.test/", { method: "POST", headers: h, body: "a" });
    expect(await verifyDiscordRequest(mk({ "X-Signature-Timestamp": String(now) }), pub, now)).toBeNull();
    expect(await verifyDiscordRequest(mk({ "X-Signature-Ed25519": sig }), pub, now)).toBeNull();
    // 署名の前後に余計な文字
    expect(await verifyDiscordRequest(mk({ "X-Signature-Ed25519": `00${sig}`, "X-Signature-Timestamp": String(now) }), pub, now)).toBeNull();
    expect(await verifyDiscordRequest(mk({ "X-Signature-Ed25519": `${sig}00`, "X-Signature-Timestamp": String(now) }), pub, now)).toBeNull();
    // タイムスタンプの前後に余計な文字（その文字列ごと正しく署名しても受け付けない）
    for (const ts of [`x${now}`, `${now}x`, ` ${now}`]) {
      expect(await verifyDiscordRequest(await signed(kp, ts, "a"), pub, now)).toBeNull();
    }
    // 13 桁のタイムスタンプ
    expect(await verifyDiscordRequest(await signed(kp, "1234567890123", "a"), pub, 1234567890123)).toBeNull();
  });

  it("公開鍵の形式が違えば、検証せずに拒否する", async () => {
    const { kp, pub } = await keyPair();
    const now = 1_800_000_000;
    expect(await verifyDiscordRequest(await signed(kp, String(now), "a"), `0${pub}`, now)).toBeNull();
    expect(await verifyDiscordRequest(await signed(kp, String(now), "a"), `${pub}0`, now)).toBeNull();
    expect(await verifyDiscordRequest(await signed(kp, String(now), "a"), `zz${pub.slice(2)}`, now)).toBeNull();
  });
});

describe("Cookie", () => {
  it("名前が一致する値だけを読む", () => {
    expect(readCookie(null, "a")).toBeNull();
    expect(readCookie("a=1; b=2", "b")).toBe("2");
    expect(readCookie(" a = 1 ;b=2", "a")).toBe("1");
    expect(readCookie("ab=1; a=2", "a")).toBe("2");
    expect(readCookie("flag; a=x=y", "a")).toBe("x=y");
    expect(readCookie("=1; a=2", "")).toBe("1");
    expect(readCookie("a=1", "b")).toBeNull();
  });
  it("セッションの Cookie は 12 時間、削除の Cookie は 0 秒", () => {
    expect(SESSION_TTL).toBe(43200);
    expect(LINK_TTL).toBe(600);
    expect(sessionCookie("p1", "sid")).toBe("__Host-s_p1=sid; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200");
    expect(clearSessionCookie("p1")).toBe("__Host-s_p1=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    expect(listSessionCookie("g1", "sid")).toBe("__Host-l_g1=sid; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200");
  });
});

describe("入力リンクとセッションのトークン", () => {
  const bad = (t: string) => [`!${t.slice(1)}`, `${t}a`, `a${t}`, t.slice(1)];

  it("入力リンクは期限付きで 1 回だけ使える。形式が違うトークンは受け付けない", async () => {
    const { pollId } = await seedPoll();
    const before = nowSec();
    const token = tokenFromUrl(await issueLink(db(), ORIGIN, pollId, ORGANIZER, "organizer", "edit"));
    for (const t of bad(token)) expect(await consumeLink(db(), t)).toBeNull();
    const row = await consumeLink(db(), token);
    expect(row).toMatchObject({ poll_id: pollId, user_id: ORGANIZER, role: "organizer", purpose: "edit" });
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + 600);
    expect(row!.expires_at).toBeLessThanOrEqual(nowSec() + 600);
    expect(await consumeLink(db(), token)).toBeNull();
    for (const t of bad(token)) expect(await lookupLinkKind(db(), t)).toBeNull();
    expect(await lookupLinkKind(db(), token)).toBe("edit");
  });

  it("調整のセッションは 12 時間有効で、形式が違う ID では引けない", async () => {
    const { pollId } = await seedPoll();
    const before = nowSec();
    const { sid } = await createSession(db(), pollId, ORGANIZER, "organizer");
    for (const t of bad(sid)) expect(await getSession(db(), pollId, t)).toBeNull();
    const s = await getSession(db(), pollId, sid);
    expect(s!.expires_at).toBeGreaterThanOrEqual(before + 43200);
    expect(s!.expires_at).toBeLessThanOrEqual(nowSec() + 43200);
  });

  it("一覧のリンクとセッションも同じ規則", async () => {
    const before = nowSec();
    const token = tokenFromUrl(await issueListLink(db(), ORIGIN, GUILD, ORGANIZER));
    for (const t of bad(token)) {
      expect(await consumeListLink(db(), t)).toBeNull();
      expect(await lookupLinkKind(db(), t)).toBeNull();
    }
    expect(await lookupLinkKind(db(), token)).toBe("list");
    expect(await consumeListLink(db(), token)).toEqual({ guild_id: GUILD, user_id: ORGANIZER });
    expect(await consumeListLink(db(), token)).toBeNull();

    const { sid } = await createListSession(db(), GUILD, ORGANIZER);
    for (const t of bad(sid)) expect(await getListSession(db(), GUILD, t)).toBeNull();
    const s = await getListSession(db(), GUILD, sid);
    expect(s!.expires_at).toBeGreaterThanOrEqual(before + 43200);
    expect(s!.expires_at).toBeLessThanOrEqual(nowSec() + 43200);
  });

  it("どこにも記録がないトークンは種類が分からない", async () => {
    expect(await lookupLinkKind(db(), "A".repeat(43))).toBeNull();
  });
});
