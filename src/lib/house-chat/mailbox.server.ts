import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { HOUSE_THREAD_TYPE, isHouseThreadId, parseHouseThreadId } from "@/lib/house-thread-id";
import { assertHouseThreadAccess, teamScopeAllowsHouseThread } from "./access.server";
import { houseThreadRowForViewer, type HouseViewer } from "./model";
import { listWorkspaceHouseThreads, loadHouseThread, setHouseViewerState } from "./store.server";

/**
 * What an inbox LIST and an inbox MAILBOX write (archive, restore, mark read) do with house chats. The house
 * chat is one shared row, so folder and read state are the VIEWER's own (`houseChat.viewerState`): a resident
 * archiving the chat never archives it for the house. Everything here re-derives membership through
 * `assertHouseThreadAccess`; the stored roster only narrows which rows are worth checking.
 */

type Db = SupabaseClient;
type Row = Record<string, unknown>;

const MAX_RESIDENT_CANDIDATES = 8;

/** House chats the manager portal's Communication shows this viewer: the active workspace's, by team access. */
export async function houseRowsForTeamViewer(
  db: Db,
  input: { userId: string; email: string; scope: CommunicationScope; inboxScope: string },
): Promise<Row[]> {
  const workspaceId = input.scope.activeWorkspaceId;
  if (!workspaceId) return [];
  const threads = await listWorkspaceHouseThreads(db, [workspaceId]);
  const viewer: HouseViewer = { userId: input.userId, email: input.email, scope: input.inboxScope, kind: "team" };
  const rows: Row[] = [];
  for (const thread of threads) {
    const parsed = parseHouseThreadId(thread.id);
    if (!parsed) continue;
    if (!teamScopeAllowsHouseThread(input.scope, parsed).allowed) continue;
    // A house that left the workspace takes its chat out of the list.
    if (input.scope.workspaceHouseIds && !input.scope.workspaceHouseIds.has(parsed.propertyId)) continue;
    rows.push({
      ...houseThreadRowForViewer({ id: thread.id, row_data: thread.rowData }, viewer),
      ownerUserId: thread.ownerUserId,
      updatedAt: thread.updatedAt,
    });
  }
  return rows;
}

/** House chats a resident is in: candidates from the stored roster, each one re-checked against occupancy. */
export async function houseRowsForResident(
  db: Db,
  input: { userId: string; email: string; inboxScope: string },
  deps: Parameters<typeof assertHouseThreadAccess>[2] = {},
): Promise<Row[]> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) return [];
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("id")
    .eq("thread_type", HOUSE_THREAD_TYPE)
    .contains("row_data", { houseChat: { residents: [{ email }] } })
    .limit(MAX_RESIDENT_CANDIDATES);
  if (error) return [];
  const viewer: HouseViewer = { userId: input.userId, email, scope: input.inboxScope, kind: "resident" };
  const rows: Row[] = [];
  for (const candidate of (data ?? []) as Row[]) {
    const id = String(candidate.id ?? "");
    const access = await assertHouseThreadAccess(db, { threadId: id, userId: input.userId, email, level: "read", kinds: ["resident"] }, deps);
    if (!access.ok) continue;
    const stored = await loadHouseThread(db, id);
    if (!stored) continue;
    rows.push({
      ...houseThreadRowForViewer({ id: stored.id, row_data: stored.rowData }, viewer),
      ownerUserId: stored.ownerUserId,
      updatedAt: stored.updatedAt,
    });
  }
  return rows;
}

export function splitHouseIds(ids: readonly string[]): { house: string[]; other: string[] } {
  const house: string[] = [];
  const other: string[] = [];
  for (const id of ids) (isHouseThreadId(id) ? house : other).push(id);
  return { house, other };
}

/**
 * Archive / restore / mark read, for the viewer only, on the house chats they may read. An id they cannot
 * read is skipped (never an error that reveals the chat exists). Returns how many were applied.
 */
export async function applyHouseMailboxState(
  db: Db,
  input: { userId: string; email: string },
  ids: readonly string[],
  patch: { folder?: "inbox" | "trash"; read?: boolean },
): Promise<number> {
  let applied = 0;
  for (const id of [...new Set(ids)].slice(0, 100)) {
    const access = await assertHouseThreadAccess(db, { threadId: id, userId: input.userId, email: input.email, level: "read" });
    if (!access.ok) continue;
    if (await setHouseViewerState(db, id, input.userId, patch)) applied += 1;
  }
  return applied;
}
