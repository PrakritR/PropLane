import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { managerPropertyLimitMessage, type ManagerSkuTier } from "@/lib/manager-access";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { loadManagerBillingOverrides, managerPropertyCapOverrideMessage } from "@/lib/manager-billing-overrides";
import {
  LISTING_SLOT_PROPERTY_STATUSES,
  propertyStatusOccupiesListingSlot,
  type ManagerPropertyRecordStatus,
} from "@/lib/persisted-property-records";
import { RATE_CARD } from "@/lib/billing/rate-card";
import { loadManagerDoorCount } from "@/lib/billing/door-count.server";

/**
 * Server-side enforcement of the plan's listing gate (PLAN-DOOR step 2).
 *
 * The gate used to exist only in the browser (`pro-properties.tsx` disabled
 * "+ Add property", `pro-add-listing-form.tsx` refused to submit), so any
 * request that skipped the interface published as many listings as it liked —
 * `POST /api/property-records` is a plain upsert and every client posts to it
 * directly. That is the whole of audit finding F-SET-1's monetization half.
 *
 * Per-door billing changed WHAT is capped:
 *
 * - Pro and Business price extra doors instead of refusing them
 *   (`RATE_CARD`), so a paid account is never refused for listing COUNT here.
 * - Free has no overage rate — it is a hard cap of `RATE_CARD.free.includedDoors`
 *   DOORS, not listings. A free account can hold several listings as long as
 *   their doors together stay at or under the cap.
 * - A staff-pinned `propertyCap` override (`manager-billing-overrides.ts`) is
 *   a separate, per-account admin concern and keeps enforcing by raw listing
 *   COUNT regardless of tier or doors — it is checked first and, when set,
 *   replaces the plan's own rule entirely.
 *
 * Two rules keep this from ever costing a manager data:
 *
 * 1. It gates the TRANSITION INTO a listing slot, not the state of being over
 *    the cap. An account already over its limit — seeded that way, downgraded,
 *    or let past by the missing check — keeps every listing and can still edit,
 *    unlist, relist-in-place and delete them. Only a write that would occupy an
 *    ADDITIONAL slot is refused.
 * 2. The count, the doors, and the tier are all read server-side from the
 *    owner's own rows. Nothing in the request body influences any of them
 *    except `incomingDoors`, which the CALLER computes from the submission it
 *    is about to write (`doorCountForListing`) — this module never reaches
 *    into request bodies itself.
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
 *
 * `incomingDoors` is how many doors the record being written adds — the
 * caller's own count from `doorCountForListing` on the submission it is about
 * to save. It is only ever consulted for Free's door cap below; a caller that
 * omits it gets the same "never 0" floor `doorCountForListing` itself uses for
 * a listing with nothing recorded, so an untaught caller still enforces
 * something rather than going silently uncapped.
 */
export async function assertManagerPropertyListingQuota(
  db: SupabaseClient,
  params: {
    ownerUserId: string | null;
    recordId: string;
    nextStatus: ManagerPropertyRecordStatus;
    existingStatus: ManagerPropertyRecordStatus | string | null;
    incomingDoors?: number;
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

  // PropLane staff can pin this account's raw listing-count cap, which is the whole point of the
  // admin Billing override: a comped or contract account is held to the number staff set, not to
  // its plan. This is orthogonal to per-door pricing — it still enforces by listing COUNT, on any
  // tier — and, when set, replaces the plan's own rule entirely rather than adding to it. A cap we
  // could not READ is treated exactly like a plan we could not read — a 500, never a silent fall
  // back to the plan default, which would refuse a manager staff had explicitly comped a bigger
  // cap. It still only ever refuses a NEW slot; nothing here removes a record.
  const overrideResult = await loadManagerBillingOverrides(db, ownerUserId);
  if (!overrideResult.ok) return { ok: false, status: 500, error: overrideResult.error };
  const capOverride = overrideResult.overrides.propertyCap;
  if (capOverride !== null) {
    const counted = await countManagerListingSlots(db, ownerUserId, params.recordId);
    if (!counted.ok) return { ok: false, status: 500, error: counted.error };
    if (counted.count < capOverride) return { ok: true };
    return {
      ok: false,
      status: 403,
      // A staff-pinned cap must not be reported with the plan's copy: "Upgrade to Pro" is false
      // when upgrading would not move the number a staff member typed.
      error: managerPropertyCapOverrideMessage(capOverride),
      tier,
      limit: capOverride,
      current: counted.count,
    };
  }

  // Pro and Business price extra doors instead of capping listing count — never refused here.
  if (tier !== "free") return { ok: true };

  // Free has a hard door cap with NO overage rate (`RATE_CARD.free`) — there is
  // no price to quote past it, so the write is refused instead of billed.
  const doorsResult = await loadManagerDoorCount(db, ownerUserId);
  if (!doorsResult.ok) return { ok: false, status: 500, error: doorsResult.error };
  const cap = RATE_CARD.free.includedDoors;
  const incomingDoors = Math.max(1, Math.floor(params.incomingDoors ?? 1));
  const projectedDoors = doorsResult.totalDoors + incomingDoors;
  if (projectedDoors <= cap) return { ok: true };

  return {
    ok: false,
    status: 403,
    error: managerPropertyLimitMessage(tier),
    tier,
    limit: cap,
    current: doorsResult.totalDoors,
  };
}
