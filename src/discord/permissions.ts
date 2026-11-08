// Discord の権限ビット（https://discord.com/developers/docs/topics/permissions）
export const PERM = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
} as const;

/** 権限の文字列（Interaction の member.permissions など）に、指定の権限が含まれるか。管理者は常に true */
export function hasPermission(permissions: string | undefined | null, perm: bigint): boolean {
  if (!permissions || !/^\d+$/.test(permissions)) return false;
  const p = BigInt(permissions);
  return (p & PERM.ADMINISTRATOR) === PERM.ADMINISTRATOR || (p & perm) === perm;
}
