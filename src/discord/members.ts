// 参加者の自動抽出（docs/design.md §5.3）
import type { Env } from "../core/env";
import { LIMITS } from "../shared/model";
import { PERM } from "./permissions";
import { sanitizeDisplayName } from "../shared/text";
import {
  discord,
  DiscordError,
  memberDisplayName,
  type DiscordChannel,
  type DiscordMember,
  type DiscordRole,
} from "./rest";


const MAX_MEMBER_PAGES = 5; // 5000 人まで

export interface Candidate {
  userId: string;
  displayName: string;
}

export type ExtractResult =
  | { ok: true; members: Candidate[] }
  | { ok: false; reason: "intent_disabled" | "too_many" | "error"; message: string };

/** ギルドメンバーを全件取得（Server Members Intent が必要） */
async function listGuildMembers(env: Env, guildId: string): Promise<DiscordMember[] | "too_many"> {
  const all: DiscordMember[] = [];
  let after = "0";
  for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
    const batch = await discord<DiscordMember[]>(env, "GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
    all.push(...batch);
    if (batch.length < 1000) return all;
    after = batch[batch.length - 1]!.user!.id;
  }
  return "too_many";
}

/** チャンネルの閲覧権限を持つかどうか（Discord 公式の権限計算） */
export function canViewChannel(
  member: DiscordMember,
  guildId: string,
  ownerId: string,
  roles: Map<string, DiscordRole>,
  channel: DiscordChannel,
): boolean {
  const userId = member.user?.id;
  if (!userId) return false;
  if (userId === ownerId) return true;

  let base = BigInt(roles.get(guildId)?.permissions ?? "0");
  for (const r of member.roles) base |= BigInt(roles.get(r)?.permissions ?? "0");
  if ((base & PERM.ADMINISTRATOR) === PERM.ADMINISTRATOR) return true;

  let perms = base;
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) {
    perms &= ~BigInt(everyone.deny);
    perms |= BigInt(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && member.roles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms &= ~deny;
  perms |= allow;
  const own = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (own) {
    perms &= ~BigInt(own.deny);
    perms |= BigInt(own.allow);
  }
  return (perms & PERM.VIEW_CHANNEL) === PERM.VIEW_CHANNEL;
}

function toCandidates(members: DiscordMember[]): Candidate[] {
  return members
    .filter((m) => m.user && !m.user.bot)
    .map((m) => ({ userId: m.user!.id, displayName: sanitizeDisplayName(memberDisplayName(m), LIMITS.displayNameMax) }));
}

const THREAD_TYPES = new Set([10, 11, 12]);
const PRIVATE_THREAD = 12;

export async function extractParticipants(
  env: Env,
  guildId: string,
  channelId: string,
  roleId: string | null,
): Promise<ExtractResult> {
  try {
    if (!roleId) {
      // プライベートスレッドはスレッドのメンバー
      const ch = await discord<DiscordChannel>(env, "GET", `/channels/${channelId}`);
      if (ch.type === PRIVATE_THREAD) {
        const tm = await discord<{ member?: DiscordMember }[]>(env, "GET", `/channels/${channelId}/thread-members?with_member=true&limit=100`);
        const members = tm.map((t) => t.member).filter((m): m is DiscordMember => !!m);
        return limit(toCandidates(members));
      }
      const target = THREAD_TYPES.has(ch.type) && ch.parent_id
        ? await discord<DiscordChannel>(env, "GET", `/channels/${ch.parent_id}`)
        : ch;
      const [guild, roleList, members] = await Promise.all([
        discord<{ owner_id: string }>(env, "GET", `/guilds/${guildId}`),
        discord<DiscordRole[]>(env, "GET", `/guilds/${guildId}/roles`),
        listGuildMembers(env, guildId),
      ]);
      if (members === "too_many") return tooMany();
      const roles = new Map(roleList.map((r) => [r.id, r]));
      return limit(toCandidates(members.filter((m) => canViewChannel(m, guildId, guild.owner_id, roles, target))));
    }
    const members = await listGuildMembers(env, guildId);
    if (members === "too_many") return tooMany();
    return limit(toCandidates(members.filter((m) => m.roles.includes(roleId))));
  } catch (e) {
    if (e instanceof DiscordError && e.status === 403 && e.path.includes("/members")) {
      return {
        ok: false,
        reason: "intent_disabled",
        message: "Bot の Server Members Intent が無効なため、参加者を自動で設定できませんでした。手動で参加者を選んでください。",
      };
    }
    return { ok: false, reason: "error", message: "参加者を自動で設定できませんでした。手動で参加者を選んでください。" };
  }
}

function tooMany(): ExtractResult {
  return {
    ok: false,
    reason: "too_many",
    message: "サーバーのメンバーが多すぎるため、参加者を自動で設定できませんでした。ロールを指定するか、手動で参加者を選んでください。",
  };
}

function limit(c: Candidate[]): ExtractResult {
  if (c.length > LIMITS.participantsMax) {
    return {
      ok: false,
      reason: "too_many",
      message: `参加者が ${LIMITS.participantsMax} 人を超えるため、自動で設定できませんでした。ロールを指定するか、手動で参加者を選んでください。`,
    };
  }
  return { ok: true, members: c };
}

export async function fetchMember(env: Env, guildId: string, userId: string): Promise<Candidate | null> {
  try {
    const m = await discord<DiscordMember>(env, "GET", `/guilds/${guildId}/members/${userId}`);
    if (!m.user || m.user.bot) return null;
    return { userId: m.user.id, displayName: sanitizeDisplayName(memberDisplayName(m), LIMITS.displayNameMax) };
  } catch (e) {
    if (e instanceof DiscordError && e.status === 404) return null;
    throw e;
  }
}

export async function searchMembers(env: Env, guildId: string, query: string): Promise<Candidate[]> {
  const q = encodeURIComponent(query.slice(0, 32));
  const members = await discord<DiscordMember[]>(env, "GET", `/guilds/${guildId}/members/search?query=${q}&limit=25`);
  return toCandidates(members);
}
