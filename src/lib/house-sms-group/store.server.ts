import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HOUSE_THREAD_TYPE, houseThreadId } from "@/lib/house-thread-id";
import {
  ensureHouseThread,
  listWorkspaceHouseThreads,
  loadHouseThread,
  mutateHouseThread,
  type StoredHouseThread,
} from "@/lib/house-chat/store.server";
import { readSmsGroupState, withSmsGroupState, type SmsGroupState } from "./model";

/**
 * Storage of a house's SMS group: `row_data.smsGroup` on the one in-app house chat row (no table of its own).
 * Every change is the house chat's compare-and-set (`mutateHouseThread`), so two writers never overwrite each other.
 */

export { ensureHouseThread, loadHouseThread };

export async function loadHouseSmsGroup(
  db: SupabaseClient,
  threadId: string,
): Promise<{ stored: StoredHouseThread; state: SmsGroupState | null } | null> {
  const stored = await loadHouseThread(db, threadId);
  return stored ? { stored, state: readSmsGroupState(stored.rowData) } : null;
}

export function threadIdFor(input: { ownerUserId: string; workspaceId: string; propertyId: string }): string {
  return houseThreadId(input.ownerUserId, input.workspaceId, input.propertyId);
}

/**
 * The house chat a Conversations webhook belongs to. The SID is matched on the stored row only; a SID that
 * names no house chat (the W10 RA groups, anything else) resolves to `null` and the caller falls through.
 */
export async function findThreadByConversationSid(db: SupabaseClient, conversationSid: string): Promise<StoredHouseThread | null> {
  const sid = conversationSid.trim();
  if (!/^CH[a-zA-Z0-9]{32}$/.test(sid)) return null;
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, owner_user_id, workspace_id, updated_at")
    .eq("thread_type", HOUSE_THREAD_TYPE)
    .eq("row_data->smsGroup->>conversationSid", sid)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    rowData: (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>,
    ownerUserId: String(row.owner_user_id ?? ""),
    workspaceId: (row.workspace_id as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

/** Every house of a workspace that has an SMS group, with its state (collision checks, the daily sweep). */
export async function listWorkspaceSmsGroups(
  db: SupabaseClient,
  workspaceId: string,
): Promise<{ threadId: string; propertyId: string; state: SmsGroupState }[]> {
  const threads = await listWorkspaceHouseThreads(db, [workspaceId]);
  const out: { threadId: string; propertyId: string; state: SmsGroupState }[] = [];
  for (const t of threads) {
    const state = readSmsGroupState(t.rowData);
    const propertyId = typeof t.rowData.houseId === "string" ? t.rowData.houseId : "";
    if (state && propertyId) out.push({ threadId: t.id, propertyId, state });
  }
  return out;
}

/** Replace a house's group state under the chat's compare-and-set. `change` gets the current state (null when none). */
export async function saveSmsGroupState(
  db: SupabaseClient,
  threadId: string,
  change: (current: SmsGroupState | null) => SmsGroupState | null,
): Promise<boolean> {
  return mutateHouseThread(db, threadId, (rowData) => {
    const next = change(readSmsGroupState(rowData));
    return next ? withSmsGroupState(rowData, next) : null;
  });
}
