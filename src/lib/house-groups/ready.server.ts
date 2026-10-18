import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Does this house have a live group chat to post to? W10 owns the tables (`house_group_conversations`);
 * until its migration is present every read answers "no" (missing table, missing column or any other
 * error), so a group-only preset stays silent instead of holding a draft nobody can send. Replace the
 * body with W10's own check if its column names differ.
 */
export async function houseGroupReady(db: SupabaseClient, workspaceId: string, propertyId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("house_group_conversations")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("property_id", propertyId)
      .limit(1);
    if (error) return false;
    return Boolean(data && data.length > 0);
  } catch {
    return false;
  }
}
