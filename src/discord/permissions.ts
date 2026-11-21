// Discord の権限ビット（https://discord.com/developers/docs/topics/permissions）
export const PERM = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

/** 権限の文字列（Interaction の member.permissions など）に、指定の権限が含まれるか。管理者は常に true */
export function hasPermission(permissions: string | undefined | null, perm: bigint): boolean {
  if (!permissions || !/^\d+$/.test(permissions)) return false;
  const p = BigInt(permissions);
  return (p & PERM.ADMINISTRATOR) === PERM.ADMINISTRATOR || (p & perm) === perm;
}

/** スレッドのチャンネルの種類（お知らせのスレッド・公開スレッド・プライベートスレッド） */
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

/** Discord の画面での権限の名前（日本語・英語） */
const PERM_NAMES: Record<"VIEW_CHANNEL" | "SEND_MESSAGES" | "SEND_MESSAGES_IN_THREADS" | "EMBED_LINKS", { ja: string; en: string }> = {
  VIEW_CHANNEL: { ja: "チャンネルを見る", en: "View Channel" },
  SEND_MESSAGES: { ja: "メッセージを送信", en: "Send Messages" },
  SEND_MESSAGES_IN_THREADS: { ja: "スレッドでメッセージを送信", en: "Send Messages in Threads" },
  EMBED_LINKS: { ja: "埋め込みリンク", en: "Embed Links" },
};

/**
 * 募集メッセージの投稿に要る権限のうち、Bot がこのチャンネルで持っていないもの（docs/design.md §5.2）。
 * appPermissions は Interaction の app_permissions（そのチャンネルでの Bot の権限）。届かなかったときは確かめない（空を返す）
 */
export function missingPostPermissions(appPermissions: string | undefined | null, channelType: number | undefined): { ja: string; en: string }[] {
  if (appPermissions === undefined || appPermissions === null) return [];
  const thread = channelType !== undefined && THREAD_CHANNEL_TYPES.has(channelType);
  const keys = ["VIEW_CHANNEL", thread ? "SEND_MESSAGES_IN_THREADS" : "SEND_MESSAGES", "EMBED_LINKS"] as const;
  return keys.filter((k) => !hasPermission(appPermissions, PERM[k])).map((k) => PERM_NAMES[k]);
}
