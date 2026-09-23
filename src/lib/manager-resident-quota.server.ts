import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  managerResidentLimitMessage,
  maxResidentsForManagerTier,
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { addonUnitsForCap, loadManagerPlanAddonQuantities } from "@/lib/plan-addons.server";

export const MANAGER_RESIDENT_LIMIT_ERROR_CODE = "resident_limit_reached";

export type ManagerResidentQuotaVerdict =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 500;
      error: string;
      code?: typeof MANAGER_RESIDENT_LIMIT_ERROR_CODE;
      tier?: ManagerSkuTier | null;
      limit?: number;
      current?: number;
    };

/**
 * Count approved / manually-added residents for the owner. Used for display and
 * the new-slot gate. Edits to existing rows are never refused here.
 */
export async function countManagerResidents(
  db: SupabaseClient,
  ownerUserId: string,
  excludeRecordId?: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  let query = db
    .from("manager_application_records")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", ownerUserId)
    .or("row_data->>bucket.eq.approved,row_data->>manuallyAdded.eq.true");
  if (excludeRecordId?.trim()) query = query.neq("id", excludeRecordId.trim());
  const { count, error } = await query;
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

/**
 * Refuse creating / newly approving a resident when the account is already at
 * its plan resident cap. Grandfathers existing rows: only NEW slots are blocked.
 */
export async function assertManagerResidentQuota(
  db: SupabaseClient,
  params: {
    ownerUserId: string | null;
    /** True when this write would occupy an additional resident slot. */
    occupiesNewSlot: boolean;
    excludeRecordId?: string;
  },
): Promise<ManagerResidentQuotaVerdict> {
  if (!params.occupiesNewSlot) return { ok: true };
  const ownerUserId = params.ownerUserId?.trim();
  if (!ownerUserId) return { ok: true };

  const tierResult = await getEffectiveManagerSkuTier(ownerUserId);
  if (!tierResult.ok) {
    return { ok: false, status: 500, error: "Could not verify your plan." };
  }
  const base = maxResidentsForManagerTier(tierResult.tier);
  if (base == null) return { ok: true };
  const addons = await loadManagerPlanAddonQuantities(db, ownerUserId);
  const limit = base + (addons.ok ? addonUnitsForCap(addons.quantities, "extra_resident", tierResult.tier) : 0);

  const counted = await countManagerResidents(db, ownerUserId, params.excludeRecordId);
  if (!counted.ok) {
    return { ok: false, status: 500, error: "Could not verify your resident count." };
  }
  if (counted.count >= limit) {
    return {
      ok: false,
      status: 403,
      error: managerResidentLimitMessage(tierResult.tier),
      code: MANAGER_RESIDENT_LIMIT_ERROR_CODE,
      tier: tierResult.tier,
      limit,
      current: counted.count,
    };
  }
  return { ok: true };
}
