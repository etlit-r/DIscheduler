// スラッシュコマンドの登録と、サーバーの既定値（Stryker で検出できなかったミュータントへの対策）
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, resetCommandsCache, syncCommands } from "../src/discord/commands";
import { buildSettingsMessage, canManageGuild, DEFAULT_SETTINGS, getGuildSettings, saveGuildSettings } from "../src/guilds/settings";
import { PERM } from "../src/discord/permissions";
import type { Env } from "../src/core/env";
import { mockDiscord, testEnv } from "./helpers";

const db = () => (env as unknown as Env).DB;

describe("スラッシュコマンドの定義", () => {
  it("/schedule と /di を、同じオプションで定義する", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(["schedule", "di"]);
    const [a, b] = COMMANDS;
    expect({ ...a, name: "" }).toEqual({ ...b, name: "" });
    expect(a).toMatchObject({ type: 1, contexts: [0], integration_types: [0] });
    expect(a!.description).not.toBe("");
    expect(a!.description_localizations.ja).not.toBe("");
  });
  it("オプションの種類・名前・制限", () => {
    const opts = COMMANDS[0]!.options;
    expect(opts.map((o) => [o.type, o.name, o.required])).toEqual([
      [3, "title", false],
      [3, "members", false],
      [8, "role", false],
      [4, "deadline", false],
    ]);
    for (const o of opts) {
      expect(o.description).not.toBe("");
      expect(o.description_localizations.ja).not.toBe("");
    }
    expect(opts[0]).toMatchObject({ max_length: 100 });
    expect(opts[1]!.choices!.map((c) => c.value)).toEqual(["auto", "manual"]);
    expect(opts[1]!.choices!.map((c) => c.name)).toEqual(["auto", "manual"]);
    for (const c of opts[1]!.choices!) expect(c.name_localizations.ja).not.toBe("");
    expect(opts[3]).toMatchObject({ min_value: 1, max_value: 90 });
  });
});

describe("スラッシュコマンドの登録", () => {
  beforeEach(async () => {
    resetCommandsCache();
    await db().prepare("DELETE FROM meta WHERE key = 'commands_version'").run();
  });
  afterEach(() => vi.restoreAllMocks());

  it("初回は登録し、版を記録する。2 回目は Discord にも D1 にも問い合わせない", async () => {
    const calls = mockDiscord();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await syncCommands(testEnv());
    expect(calls).toEqual([{ method: "PUT", path: "/applications/100000000000000001/commands", body: COMMANDS }]);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "commands_registered" }));
    const row = await db().prepare("SELECT value FROM meta WHERE key = 'commands_version'").first<{ value: string }>();
    expect(row?.value).toMatch(/^[0-9a-f]{64}$/);

    const prepare = vi.spyOn(db(), "prepare");
    await syncCommands(testEnv());
    expect(calls).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("記録済みの版と同じなら登録しない。force でも D1 の版が同じなら登録しない", async () => {
    const calls = mockDiscord();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await syncCommands(testEnv());
    resetCommandsCache();
    await syncCommands(testEnv());
    await syncCommands(testEnv(), { force: true });
    expect(calls).toHaveLength(1);
  });

  it("force のときは、この isolate で確認済みでも D1 を読み直す", async () => {
    const calls = mockDiscord();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await syncCommands(testEnv());
    await db().prepare("UPDATE meta SET value = 'old' WHERE key = 'commands_version'").run();
    await syncCommands(testEnv());
    expect(calls).toHaveLength(1);
    await syncCommands(testEnv(), { force: true });
    expect(calls).toHaveLength(2);
  });

  it("アプリケーション ID が変われば登録し直す", async () => {
    const calls = mockDiscord();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await syncCommands(testEnv());
    await syncCommands(testEnv({ DISCORD_APPLICATION_ID: "100000000000000002" }));
    expect(calls.map((c) => c.path)).toEqual(["/applications/100000000000000001/commands", "/applications/100000000000000002/commands"]);
  });

  it("Bot トークンかアプリケーション ID が無ければ何もしない", async () => {
    const calls = mockDiscord();
    await syncCommands(testEnv({ DISCORD_BOT_TOKEN: "" }));
    await syncCommands(testEnv({ DISCORD_APPLICATION_ID: "" }));
    expect(calls).toHaveLength(0);
  });
});

describe("サーバーの既定値", () => {
  const guild = "200000000000000077";

  it("「サーバー管理」か管理者の権限があれば変更できる", () => {
    expect(canManageGuild(String(PERM.MANAGE_GUILD))).toBe(true);
    expect(canManageGuild(String(PERM.ADMINISTRATOR))).toBe(true);
    expect(canManageGuild(String(PERM.VIEW_CHANNEL))).toBe(false);
    expect(canManageGuild(undefined)).toBe(false);
  });

  it("保存していなければ既定値、保存すれば読める。ロール以外ではロールを記録しない", async () => {
    expect(await getGuildSettings(db(), guild)).toEqual({ mode: "channel", roleId: null, updatedBy: null, updatedAt: null });
    await saveGuildSettings(db(), guild, { mode: "role", roleId: "700" }, "u1");
    const s = await getGuildSettings(db(), guild);
    expect(s).toMatchObject({ mode: "role", roleId: "700", updatedBy: "u1" });
    expect(s.updatedAt).toBeGreaterThan(0);
    await saveGuildSettings(db(), guild, { mode: "manual", roleId: "700" }, "u2");
    expect(await getGuildSettings(db(), guild)).toMatchObject({ mode: "manual", roleId: null, updatedBy: "u2" });
  });

  it("設定メッセージ: 既定値のとき", () => {
    const m = buildSettingsMessage(DEFAULT_SETTINGS, null);
    const lines = m.content.split("\n");
    expect(lines[0]).toBe("**このサーバーの既定値（参加者の決め方）**");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("現在: 自動: コマンドを実行したチャンネルのメンバー");
    expect(lines).toHaveLength(4);
    expect(m.allowed_mentions).toEqual({ parse: [] });
    const select = m.components[0]!.components[0]! as { type: number; custom_id: string; placeholder: string; options: { label: string; value: string; default: boolean }[] };
    expect(select).toMatchObject({ type: 3, custom_id: "settings_mode" });
    expect(select.placeholder).not.toBe("");
    expect(select.options).toEqual([
      { label: "自動: コマンドを実行したチャンネルのメンバー", value: "channel", default: true },
      { label: "自動: 指定したロールのメンバー", value: "role", default: false },
      { label: "手動: 主催者が選ぶ", value: "manual", default: false },
    ]);
    const role = m.components[1]!.components[0]! as Record<string, unknown>;
    expect(role).toMatchObject({ type: 6, custom_id: "settings_role", min_values: 0, max_values: 1 });
    expect(role.placeholder).not.toBe("");
    expect(m.components.map((c) => c.type)).toEqual([1, 1]);
  });

  it("設定メッセージ: ロール・最終変更・補足", () => {
    const m = buildSettingsMessage({ mode: "role", roleId: "700", updatedBy: "u1", updatedAt: 1800000000 }, "保存しました");
    expect(m.content.split("\n").slice(3)).toEqual(["現在: 自動: 指定したロールのメンバー（<@&700>）", "最終変更: <@u1>（<t:1800000000:f>）", "", "保存しました"]);
    // ロールが未選択なら、ロールの表記を付けない
    expect(buildSettingsMessage({ mode: "role", roleId: null, updatedBy: "u1", updatedAt: null }, null).content.split("\n")).toHaveLength(4);
    expect(buildSettingsMessage({ mode: "role", roleId: null, updatedBy: null, updatedAt: null }, null).content.split("\n")[3]).toBe("現在: 自動: 指定したロールのメンバー");
    expect(buildSettingsMessage({ mode: "manual", roleId: "700", updatedBy: null, updatedAt: 1 }, null).content.split("\n")[3]).toBe("現在: 手動: 主催者が選ぶ");
    expect(buildSettingsMessage({ mode: "manual", roleId: null, updatedBy: null, updatedAt: null }, null).content.split("\n")).toHaveLength(4);
  });
});
