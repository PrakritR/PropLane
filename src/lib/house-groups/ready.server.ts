import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadActiveGroup, loadSettings } from "./store.server";

/**
 * Does this house have a live group chat to post to? The answer is W10's own: the workspace has
 * house chat switched on and the house has an active group (`house_group_conversations`, owned by
 * the same workspace). A missing table reads as "no" in the store, so a group-only preset stays
 * silent instead of holding a draft nobody can send. Quiet hours and the daily cap are not part of
 * "ready": `postToHouseGroup` reports those and the caller retries.
 */
export async function houseGroupReady(db: SupabaseClient, workspaceId: string, propertyId: string): Promise<boolean> {
  try {
    const group = await loadActiveGroup(db, propertyId);
    if (!group || group.workspaceId !== workspaceId) return false;
    return (await loadSettings(db, workspaceId)).enabled;
  } catch {
    return false;
  }
}
