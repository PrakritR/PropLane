import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The account that OWNS a property — `manager_property_records.manager_user_id`
 * — which is the account whose team, settings and workspace a property-scoped
 * notice belongs to. A co-manager acting on the owner's house is never the
 * owner, so anything routed "to the team" resolves through here rather than
 * through whoever happened to click.
 *
 * `null` when the property is unknown or the read fails: callers fall back to
 * the account they were already acting for rather than guessing an owner.
 */
export async function resolvePropertyOwnerUserId(
  db: SupabaseClient,
  propertyId: string | null | undefined,
): Promise<string | null> {
  const id = propertyId?.trim() ?? "";
  if (!id) return null;
  try {
    const { data, error } = await db
      .from("manager_property_records")
      .select("manager_user_id")
      .eq("id", id)
      .maybeSingle();
    if (error) return null;
    const owner = String((data as { manager_user_id?: unknown } | null)?.manager_user_id ?? "").trim();
    return owner || null;
  } catch {
    return null;
  }
}
