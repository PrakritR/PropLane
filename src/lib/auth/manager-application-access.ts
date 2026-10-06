import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import type { CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** The columns any by-id application action must load to authorize the caller. */
export type ApplicationAccessRecord = {
  manager_user_id?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
};

/**
 * Every property id this manager DIRECTLY owns (`manager_property_records
 * .manager_user_id = userId`). This is the ONE resolution of direct ownership
 * shared by the Applications LIST (`fetchApplicationsForManagerUser`) and every
 * by-id ACTION guard (`managerCanAccessApplicationRecord`), so the list and the
 * guards can never drift on who owns what — the exact divergence that let a
 * manager SEE an "Incomplete" draft on their own property yet be told "resident
 * is not in your portfolio" on delete. A manager owns few properties, so the
 * caller filters this set in memory rather than re-querying per candidate.
 */
export async function managerOwnedPropertyIdSet(db: ServiceClient, userId: string): Promise<Set<string>> {
  if (!userId) return new Set();
  const { data, error } = await db.from("manager_property_records").select("id").eq("manager_user_id", userId);
  if (error) {
    throw new Error(`Failed to load owned properties for manager ${userId}: ${error.message}`);
  }
  return new Set<string>((data ?? []).map((row) => String(row.id ?? "").trim()).filter(Boolean));
}

/**
 * One request's answers to the two reads `managerCanAccessApplicationRecord` makes, so a caller testing
 * MANY records for the SAME manager pays per distinct property instead of per row. Without it, a gate
 * that walks a resident's applications and then their forms re-queries `manager_property_records` and
 * the co-manager links once per row — dozens of serial queries on one write path
 * (AGENTS.md § Performance & egress). Promises are memoized, not values, so concurrent checks share the
 * in-flight read; a rejected one stays rejected, which keeps the predicate failing closed.
 *
 * Request-scoped on purpose: holding it longer would cache a revoked grant.
 */
export type ApplicationAccessMemo = {
  ownedPropertyIds(): Promise<Set<string>>;
  coManagerPermission(propertyId: string, module: "applications" | "residents", level: CoManagerPermissionLevel): Promise<boolean>;
};

export function createApplicationAccessMemo(db: ServiceClient, userId: string): ApplicationAccessMemo {
  let owned: Promise<Set<string>> | null = null;
  const permissions = new Map<string, Promise<boolean>>();
  return {
    ownedPropertyIds() {
      owned ??= managerOwnedPropertyIdSet(db, userId);
      return owned;
    },
    coManagerPermission(propertyId, module, level) {
      const key = `${propertyId}\u0000${module}\u0000${level}`;
      let hit = permissions.get(key);
      if (!hit) {
        hit = managerHasCoManagerPermissionForProperty(db, userId, propertyId, module, level);
        permissions.set(key, hit);
      }
      return hit;
    },
  };
}

/**
 * Does this manager have access to one application record?
 *
 * This is the SAME visibility test the Applications list uses
 * (`fetchApplicationsForManagerUser`): a record is the caller's when its stored
 * `manager_user_id` matches, OR the caller owns / co-manages the record's
 * property. Application `manager_user_id` is frozen at submit time and never
 * re-resolved for an abandoned "Incomplete" draft, so a property that changed
 * hands (or an unattributed draft) keeps a stale stamp — the list still shows
 * the row via property ownership, and every by-id ACTION (delete, PDF, …) MUST
 * authorize the same way or it 403s on a row the manager can plainly see.
 * Property ownership, not the frozen stamp, is the source of truth for access.
 *
 * `level` distinguishes what the caller may DO, not just what they may SEE:
 * viewing (the list, the PDF) is the default "read", but a destructive route
 * must pass the level it needs (e.g. "delete") so a co-manager restricted to
 * read-only Applications/Residents can see a row without being able to destroy
 * what it points at. Direct owners always pass regardless of level.
 */
export async function managerCanAccessApplicationRecord(
  db: ServiceClient,
  userId: string,
  record: ApplicationAccessRecord,
  options?: { level?: CoManagerPermissionLevel; memo?: ApplicationAccessMemo },
): Promise<boolean> {
  const level = options?.level ?? "read";
  if (!userId) return false;
  if (record.manager_user_id && record.manager_user_id === userId) return true;

  const candidateIds = [
    String(record.property_id ?? "").trim(),
    String(record.assigned_property_id ?? "").trim(),
  ].filter(Boolean);
  if (candidateIds.length === 0) return false;

  // A caller testing one record gets a memo of its own, which costs exactly what the uncached reads
  // did; a caller testing many passes one in and pays for each distinct property once.
  const memo = options?.memo ?? createApplicationAccessMemo(db, userId);

  // Direct ownership — resolved through the SAME `managerOwnedPropertyIdSet`
  // helper the Applications list uses, so the list and this guard can never
  // disagree about which properties the manager owns.
  const owned = await memo.ownedPropertyIds();
  if (candidateIds.some((id) => owned.has(id))) return true;

  // Co-manager grant at `level` on EITHER the applications or residents module —
  // the same union the list applies (the client then filters each tab by its own
  // grant). This is the ONE level-aware check: `assertCanDeleteApplicationRecords`
  // delegates here at level "delete" rather than running its own.
  for (const propertyId of candidateIds) {
    if (await memo.coManagerPermission(propertyId, "applications", level)) {
      return true;
    }
    if (await memo.coManagerPermission(propertyId, "residents", level)) {
      return true;
    }
  }
  return false;
}
