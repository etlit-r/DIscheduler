// Discord Interaction の Ed25519 署名検証（docs/security-design.md §4.1）

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(publicKeyHex: string): Promise<CryptoKey> {
  let key = keyCache.get(publicKeyHex);
  if (!key) {
    key = crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    keyCache.set(publicKeyHex, key);
  }
  return key;
}

/** 検証に成功したら生の本文を返す。失敗したら null（本文はパースしない） */
export async function verifyDiscordRequest(req: Request, publicKeyHex: string, nowSec: number): Promise<string | null> {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !/^\d{1,12}$/.test(ts)) return null;
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) return null;
  // リプレイ対策: ±5 分
  if (Math.abs(nowSec - Number(ts)) > 300) return null;
  const body = await req.text();
  const key = await importKey(publicKeyHex);
  const ok = await crypto.subtle.verify("Ed25519", key, hexToBytes(sig), new TextEncoder().encode(ts + body));
  return ok ? body : null;
}
