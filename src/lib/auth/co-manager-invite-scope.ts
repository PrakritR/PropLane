import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Security: a co-manager invite's `assigned_property_ids` is the ownership key
 * every downstream co-manager gate reads (`manager-lease-scope.ts` →
 * `assertCoManagerModuleAccess`). It was previously stored verbatim from the
 * request body, so a manager could name **another manager's** property id —
 * harvested from the public `GET /api/property-records/public` listing feed —
 * and, once the invite was accepted, pass every module gate on that property:
 * read leases, financials and documents, edit the listing, even delete it.
 *
 * The permission map does not save you here: the inviter chooses it, so a
 * forged link simply carries whatever grant its author wanted. The list must
 * therefore be validated against real ownership, not trusted.
 *
 * Returns the ids in `propertyIds` that `managerUserId` does NOT own. An empty
 * array means every id checked out. Ids that do not exist at all are reported
 * as unowned — absence is not permission.
 */
export async function findPropertyIdsNotOwnedByManager(
  db: SupabaseClient,
  managerUserId: string,
  propertyIds: string[],
): Promise<{ ok: true; unowned: string[] } | { ok: false; error: string }> {
  const unique = [...new Set(propertyIds.map((id) => String(id).trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: true, unowned: [] };

  const { data, error } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .in("id", unique);

  // Fail closed: if ownership cannot be established, no id is treated as owned.
  // Log it — the caller turns this into a 403/500, and a transient failure here
  // otherwise reads as "co-manager invites mysteriously stopped working" with
  // nothing to correlate against.
  if (error) {
    console.error("Co-manager property ownership lookup failed:", error.message);
    return { ok: false, error: error.message };
  }

  const owned = new Set((data ?? []).map((row) => String((row as { id: unknown }).id)));
  return { ok: true, unowned: unique.filter((id) => !owned.has(id)) };
}
