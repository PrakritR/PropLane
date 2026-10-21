/**
 * House chat thread ids. Pure (no server imports) so the visibility rule, the
 * client list and the tests all read an id the same way.
 *
 * One in-app group conversation per house per workspace:
 * `house-thread:<ownerId>:ws:<workspaceId>:prop:<propertyId>`, stored once,
 * `thread_type: "house"`, with the conversation key `house:<propertyId>` so the
 * existing resolve-or-create path (one row per owner, workspace, scope and key)
 * can never mint a second chat for the same house.
 */
const HOUSE_THREAD_PREFIX = "house-thread:";
const HOUSE_THREAD_PATTERN = /^house-thread:([^:]+):ws:([^:]+):prop:(.+)$/;

export const HOUSE_THREAD_TYPE = "house";

/** The neutral first line of a house chat, so no person's first message is dressed as the thread's own. */
export const HOUSE_ROOT_TEXT = "This is the house chat. Everyone who lives here and the team that runs the house are in it.";

export function houseThreadId(ownerManagerUserId: string, workspaceId: string, propertyId: string): string {
  return `${HOUSE_THREAD_PREFIX}${ownerManagerUserId.trim()}:ws:${workspaceId.trim()}:prop:${propertyId.trim()}`;
}

/** The conversation key a house chat is stored under (`portal_inbox_thread_records.conversation_key`). */
export function houseConversationKey(propertyId: string): string {
  return `house:${propertyId.trim()}`;
}

export function isHouseThreadId(id: string): boolean {
  return id.startsWith(HOUSE_THREAD_PREFIX);
}

export type ParsedHouseThreadId = { ownerManagerUserId: string; workspaceId: string; propertyId: string };

/** The owner, workspace and house a house-thread id names; `null` for any other (or a malformed) id. */
export function parseHouseThreadId(id: string): ParsedHouseThreadId | null {
  const match = HOUSE_THREAD_PATTERN.exec(id);
  if (!match) return null;
  const [, ownerManagerUserId, workspaceId, propertyId] = match;
  if (!ownerManagerUserId?.trim() || !workspaceId?.trim() || !propertyId?.trim()) return null;
  return { ownerManagerUserId: ownerManagerUserId.trim(), workspaceId: workspaceId.trim(), propertyId: propertyId.trim() };
}

export const HOUSE_THREAD_DISPLAY_NAME = "House";

/** "House · <house name or address>". */
export function houseThreadDisplayName(houseLabel?: string | null): string {
  const label = houseLabel?.trim();
  return label ? `${HOUSE_THREAD_DISPLAY_NAME} · ${label}` : HOUSE_THREAD_DISPLAY_NAME;
}

/** Is this stored/list row a house chat (by id or by type)? */
export function isHouseInboxThread(thread: { id: string; threadType?: string | null; thread_type?: string | null }): boolean {
  return thread.threadType === HOUSE_THREAD_TYPE || thread.thread_type === HOUSE_THREAD_TYPE || isHouseThreadId(thread.id);
}
