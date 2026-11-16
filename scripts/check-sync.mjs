// 2 か所に書く必要のある値が、そろっているかを確かめる（CI のテストで実行する。npm run check-sync）
// - public/_headers の /* のヘッダー（静的配信）と、src/security-headers.json（Functions の応答。src/index.ts）
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const errors = [];

// public/_headers の「/*」の段落を読む
const want = JSON.parse(read("src/security-headers.json")).headers;
const lines = read("public/_headers").split("\n");
const start = lines.findIndex((l) => l.trim() === "/*");
const got = {};
for (const l of lines.slice(start + 1)) {
  if (!/^\s+\S/.test(l)) break;
  const i = l.indexOf(":");
  got[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
if (start < 0) errors.push("public/_headers に /* の段落がありません");
for (const [k, v] of Object.entries(want)) {
  if (got[k] !== v) errors.push(`public/_headers の ${k} が src/security-headers.json と違います\n  _headers: ${got[k] ?? "(なし)"}\n  json:     ${v}`);
}
for (const k of Object.keys(got)) if (!(k in want)) errors.push(`public/_headers の ${k} は src/security-headers.json にありません`);

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log("check-sync: OK");
