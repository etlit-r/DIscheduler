// サーバーごとの既定値（docs/design.md §5.3.1）
// 変更できるのは「サーバー管理」権限を持つメンバーだけ。権限は署名済みの Interaction の値で判定する。
import { nowSec } from "../core/lib";
import { hasPermission, PERM } from "../discord/permissions";

export type DefaultMode = "channel" | "role" | "manual";

export interface GuildSettings {
  mode: DefaultMode;
  roleId: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export const DEFAULT_SETTINGS: GuildSettings = { mode: "channel", roleId: null, updatedBy: null, updatedAt: null };

/** 「サーバー管理」権限（MANAGE_GUILD）または管理者権限 */
export function canManageGuild(permissions: string | undefined): boolean {
  return hasPermission(permissions, PERM.MANAGE_GUILD);
}

export async function getGuildSettings(db: D1Database, guildId: string): Promise<GuildSettings> {
  const row = await db
    .prepare("SELECT mode, role_id, updated_by, updated_at FROM guild_settings WHERE guild_id = ?")
    .bind(guildId)
    .first<{ mode: DefaultMode; role_id: string | null; updated_by: string; updated_at: number }>();
  if (!row) return DEFAULT_SETTINGS;
  return { mode: row.mode, roleId: row.role_id, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

export async function saveGuildSettings(db: D1Database, guildId: string, s: { mode: DefaultMode; roleId: string | null }, userId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO guild_settings (guild_id, mode, role_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(guild_id) DO UPDATE SET mode = excluded.mode, role_id = excluded.role_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(guildId, s.mode, s.mode === "role" ? s.roleId : null, userId, nowSec())
    .run();
}

const MODE_LABEL: Record<DefaultMode, string> = {
  channel: "自動: コマンドを実行したチャンネルのメンバー",
  role: "自動: 指定したロールのメンバー",
  manual: "手動: 主催者が選ぶ",
};

/** 既定値の設定メッセージ（本人にだけ表示） */
export function buildSettingsMessage(s: GuildSettings, note: string | null) {
  const current =
    s.mode === "role" && s.roleId ? `${MODE_LABEL.role}（<@&${s.roleId}>）` : MODE_LABEL[s.mode];
  const lines = [
    "**このサーバーの既定値（参加者の決め方）**",
    "`/schedule`（`/poll`）でオプションを指定しなかったときに使われます。主催者は調整ごとに作成画面で変更できます。",
    "",
    `現在: ${current}`,
  ];
  if (s.updatedBy && s.updatedAt) lines.push(`最終変更: <@${s.updatedBy}>（<t:${s.updatedAt}:f>）`);
  if (note) lines.push("", note);
  return {
    content: lines.join("\n"),
    allowed_mentions: { parse: [] as string[] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "settings_mode",
            placeholder: "参加者の決め方を選ぶ",
            options: (["channel", "role", "manual"] as const).map((m) => ({ label: MODE_LABEL[m], value: m, default: m === s.mode })),
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 6, // ロールの選択
            custom_id: "settings_role",
            placeholder: "既定のロールを選ぶ（「指定したロールのメンバー」のとき）",
            min_values: 0,
            max_values: 1,
            // 保存済みのロールは本文に表示し、選択メニューでは選んだ状態にしない
            // （そのロールが削除されていると、Discord が default_values を受け付けず画面が開けないおそれがあるため）
          },
        ],
      },
    ],
  };
}
