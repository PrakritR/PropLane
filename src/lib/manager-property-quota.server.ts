import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  managerPropertyLimitMessage,
  maxPropertiesForManagerTier,
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import {
  loadManagerBillingOverrides,
  managerPropertyCapOverrideMessage,
  resolveManagerPropertyCap,
} from "@/lib/manager-billing-overrides";
import {
  LISTING_SLOT_PROPERTY_STATUSES,
  propertyStatusOccupiesListingSlot,
  type ManagerPropertyRecordStatus,
} from "@/lib/persisted-property-records";

/**
 * Server-side enforcement of the plan's property-listing cap.
 *
 * The cap used to exist only in the browser (`manager-properties.tsx` disabled
 * "+ Add property", `manager-add-listing-form.tsx` refused to submit), so any
 * request that skipped the interface published as many listings as it liked —
 * `POST /api/property-records` is a plain upsert and every client posts to it
 * directly. That is the whole of audit finding F-SET-1's monetization half.
 *
 * Two rules keep this from ever costing a manager data:
 *
 * 1. It gates the TRANSITION INTO a listing slot, not the state of being over
 *    the cap. An account already over its limit — seeded that way, downgraded,
 *    or let past by the missing check — keeps every listing and can still edit,
 *    unlist, relist-in-place and delete them. Only a write that would occupy an
 *    ADDITIONAL slot is refused.
 * 2. The count and the tier are both read server-side from the owner's own
 *    rows. Nothing in the request body influences either.
 */

export type ManagerPropertyQuotaRefusal = {
  ok: false;
  status: 403;
  error: string;
  tier: ManagerSkuTier | null;
  limit: number;
  current: number;
};

export type ManagerPropertyQuotaVerdict = { ok: true } | ManagerPropertyQuotaRefusal;

/** Listing slots the owner currently holds, ignoring one record id (the row being written). */
export async function countManagerListingSlots(
  db: SupabaseClient,
  ownerUserId: string,
  excludeRecordId?: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  let query = db
    .from("manager_property_records")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", ownerUserId)
    .in("status", [...LISTING_SLOT_PROPERTY_STATUSES]);
  if (excludeRecordId?.trim()) query = query.neq("id", excludeRecordId.trim());

  const { count, error } = await query;
  // A failed count must never be read as "zero used" — that would wave the
  // write through on exactly the transient error the cap exists to survive.
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

/**
 * Decide whether `ownerUserId` may put record `recordId` into `nextStatus`.
 *
 * `existingStatus` is the status stored for that record right now (`null` when
 * the row does not exist yet). A row that ALREADY occupies a listing slot — an
 * ordinary edit or re-mirror of a live listing — is never re-charged, which is
 * what lets an over-limit portfolio keep working normally.
 */
export async function assertManagerPropertyListingQuota(
  db: SupabaseClient,
  params: {
    ownerUserId: string | null;
    recordId: string;
    nextStatus: ManagerPropertyRecordStatus;
    existingStatus: ManagerPropertyRecordStatus | string | null;
  },
): Promise<ManagerPropertyQuotaVerdict | { ok: false; status: 500; error: string }> {
  // The write does not land in a listing slot (draft, unlisted, rejected,
  // request_change), or the row is already holding one.
  if (!propertyStatusOccupiesListingSlot(params.nextStatus)) return { ok: true };
  if (propertyStatusOccupiesListingSlot(params.existingStatus)) return { ok: true };

  // `manager_user_id` is `on delete set null`, so an ownerless row is a real
  // production state. There is no plan to hold it to; leave it to the route's
  // own authorization, which is what already governs who may touch it.
  const ownerUserId = params.ownerUserId?.trim();
  if (!ownerUserId) return { ok: true };

  // A plan we could not read is not the Free plan. Zero purchase rows come back
  // both when the account never bought anything and when the read failed, and
  // that resolves to Free — so treating an unreadable plan as a resolved one
  // would cap a paying manager on a transient error. Fail closed with a 500,
  // the same way the slot count below refuses to be read as "zero used".
  const tierResult = await getEffectiveManagerSkuTier(ownerUserId);
  if (!tierResult.ok) return { ok: false, status: 500, error: tierResult.error };
  const tier = tierResult.tier;

  // PropLane staff can pin this account's cap, which is the whole point of the admin Billing
  // override: a comped or contract account is held to the number staff set, not to its plan.
  // A cap we could not READ is treated exactly like a plan we could not read — a 500, never a
  // silent fall back to the plan default, which would refuse a manager staff had explicitly
  // comped a bigger cap. It still only ever refuses a NEW slot; nothing here removes a record.
  const overrideResult = await loadManagerBillingOverrides(db, ownerUserId);
  if (!overrideResult.ok) return { ok: false, status: 500, error: overrideResult.error };

  const cap = resolveManagerPropertyCap({
    planLimit: maxPropertiesForManagerTier(tier),
    capOverride: overrideResult.overrides.propertyCap,
  });
  if (cap.limit === null) return { ok: true };

  const counted = await countManagerListingSlots(db, ownerUserId, params.recordId);
  if (!counted.ok) return { ok: false, status: 500, error: counted.error };
  if (counted.count < cap.limit) return { ok: true };

  return {
    ok: false,
    status: 403,
    // A staff-pinned cap must not be reported with the plan's copy: "Upgrade to Pro" is false
    // when upgrading would not move the number a staff member typed.
    error: cap.source === "override" ? managerPropertyCapOverrideMessage(cap.limit) : managerPropertyLimitMessage(tier),
    tier,
    limit: cap.limit,
    current: counted.count,
  };
}
