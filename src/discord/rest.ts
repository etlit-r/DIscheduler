// Discord REST API クライアント（レート制限に従う。docs/security-design.md D-4）
import type { Env } from "../core/env";
import { sleep } from "../core/lib";

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`Discord API ${status} ${path}`);
  }
}

const UA = "DiscordBot (https://github.com/yuka-okaniwa/DIscheduler, 1.0)";

export async function discord<T = unknown>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: "bot" | "none"; reason?: string } = {},
): Promise<T> {
  const base = env.DISCORD_API_BASE ?? "https://discord.com/api/v10";
  const headers: Record<string, string> = { "User-Agent": UA };
  if (opts.auth !== "none") headers.Authorization = `Bot ${env.DISCORD_BOT_TOKEN}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(opts.reason);

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt === 0) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Math.min(Math.max(data.retry_after ?? 1, 0), 5);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new DiscordError(res.status, (await res.text()).slice(0, 500), path);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  throw new DiscordError(429, "rate limited", path);
}

// --- よく使う型（必要な項目だけ） ---

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordMember {
  user?: DiscordUser;
  nick?: string | null;
  roles: string[];
  permissions?: string;
}

export interface DiscordRole {
  id: string;
  name: string;
  permissions: string;
  managed?: boolean;
  position: number;
}

export interface PermissionOverwrite {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow: string;
  deny: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
  permission_overwrites?: PermissionOverwrite[];
}

export function memberDisplayName(m: DiscordMember): string {
  return m.nick || m.user?.global_name || m.user?.username || "（名前なし）";
}
