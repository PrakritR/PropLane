import "server-only";

import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ManagerReportScope = {
  /** Effective manager id whose books the report reads. */
  managerUserId: string;
  /**
   * The exact property ids the viewer's `financials` grant covers under
   * `managerUserId`, to narrow every report query beyond the owner
   * substitution itself. `null` means NO additional narrowing from this — the
   * viewer is reading their OWN books as a primary owner (their property list
   * IS their scope already; workspace narrowing still applies on top). An
   * EMPTY ARRAY means the co-manager's `financials` grant covers no property
   * under this owner, so the report has nothing to report — never falls back
   * to the owner's everything.
   */
  grantedPropertyIds: string[] | null;
};

/**
 * Resolves which manager's financial books a report should read, AND the
 * exact set of that owner's properties the viewer is actually allowed to see
 * rows for.
 *
 * Financial reports (income statement, balance sheet, trial balance, GL, rent
 * roll, expenses…) aggregate ledger/GL rows that aren't all property-tagged, so
 * they can't be filtered per property the way list modules are on their own —
 * they still need an explicit property-id scope handed to them. Financials is
 * therefore treated as an OWNER-LEVEL grant, matching the vendor-directory
 * precedent (`linkedOwnerScopeForModule`): a co-manager granted `financials` on
 * any assigned property reads that owner's books, but ONLY the rows tagged to
 * the property (or properties) the grant actually names — never the owner's
 * other houses, and never other workspaces of that owner.
 *
 * Resolution:
 * - A primary manager (owns ≥1 property) always reads their OWN books, with no
 *   additional narrowing from this function (`grantedPropertyIds: null`).
 * - A pure co-manager reads the books of an owner who granted them `financials`,
 *   narrowed to exactly the properties that grant covers under that owner.
 *   With more than one such owner we pick the lowest owner id deterministically;
 *   a per-owner selector for multi-owner co-managers is future work (the report
 *   UI has no owner picker yet).
 * - Otherwise (no ownership, no financials grant) it falls back to the user's own
 *   id, so they only ever see their own — empty — books, never someone else's.
 *
 * Because substitution happens ONLY when a financials grant exists, this doubles
 * as the access check: a co-manager without `financials` can never reach an
 * owner's books through it. The returned `grantedPropertyIds` is what makes the
 * grant also bound WHICH of that owner's houses the report may read — callers
 * MUST intersect it into every report query (see `intersectPropertyScopes` in
 * `@/lib/reports/workspace-scope`), never call this and skip that step.
 */
export async function resolveManagerReportScope(
  db: ServiceClient,
  userId: string,
): Promise<ManagerReportScope> {
  const { data: owned } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", userId)
    .limit(1);
  if ((owned ?? []).length > 0) return { managerUserId: userId, grantedPropertyIds: null };

  const { ownerIds, propertyIdsByOwner } = await linkedOwnerScopeForModule(db, userId, "financials");
  if (ownerIds.size === 0) return { managerUserId: userId, grantedPropertyIds: null };
  const ownerId = [...ownerIds].sort()[0];
  const granted = propertyIdsByOwner.get(ownerId) ?? new Set<string>();
  return { managerUserId: ownerId, grantedPropertyIds: [...granted] };
}
