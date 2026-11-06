// スラッシュコマンドの定義と登録（docs/design.md §4.4）
// Bot トークンは Cloudflare にだけ置くため、登録は Worker 自身が行う。
// 定義が変わったときだけ（meta テーブルの版と比べて）Discord に登録し直す。
import type { Env } from "../env";
import { sha256Hex } from "../lib";
import { discord } from "./rest";

function commandDef(name: string) {
  return {
    name,
    type: 1,
    description: "Create a schedule poll for this channel",
    description_localizations: { ja: "このチャンネルで日程調整を作成します（何も指定せずに実行できます）" },
    contexts: [0], // ギルド内のみ
    integration_types: [0], // ギルドインストールのみ
    options: [
      {
        type: 3,
        name: "title",
        description: "Title (can be entered later on the web page)",
        description_localizations: { ja: "タイトル（あとで Web 画面でも入力できます）" },
        max_length: 100,
        required: false,
      },
      {
        type: 3,
        name: "members",
        description: "How to choose participants",
        description_localizations: { ja: "参加者の決め方" },
        required: false,
        choices: [
          { name: "auto", name_localizations: { ja: "自動（チャンネルのメンバー）" }, value: "auto" },
          { name: "manual", name_localizations: { ja: "手動で選ぶ" }, value: "manual" },
        ],
      },
      {
        type: 8,
        name: "role",
        description: "Participants are members with this role",
        description_localizations: { ja: "このロールのメンバーを参加者にする" },
        required: false,
      },
      {
        type: 4,
        name: "deadline",
        description: "Days from publishing to the deadline (default 7)",
        description_localizations: { ja: "公開から締切までの日数（既定 7 日）" },
        min_value: 1,
        max_value: 90,
        required: false,
      },
    ],
  };
}

export const COMMANDS = [commandDef("schedule"), commandDef("poll")];

export async function syncCommands(env: Env): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APPLICATION_ID) return;
  const version = await sha256Hex(JSON.stringify(COMMANDS) + env.DISCORD_APPLICATION_ID);
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'commands_version'").first<{ value: string }>();
  if (row?.value === version) return;
  await discord(env, "PUT", `/applications/${env.DISCORD_APPLICATION_ID}/commands`, COMMANDS);
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('commands_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(version)
    .run();
  console.log(JSON.stringify({ event: "commands_registered" }));
}
