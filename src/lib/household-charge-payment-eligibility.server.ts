import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  displayPropertyLabel,
  enrichHouseholdChargePaymentFlags,
  listingBuildingName,
  listingFromPropertyData,
} from "@/lib/household-charge-payment-eligibility";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** A propertyless one-off has no listing policy. Its exact owning manager's
 * stored account setting is the only fallback; an absent or unreadable setting
 * is not evidence that online payment was enabled. */
export async function resolvePropertylessManagerPaymentPolicy(
  db: SupabaseClient,
  managerUserId: string,
): Promise<boolean | null> {
  const ownerId = managerUserId.trim();
  if (!ownerId) return null;
  let result = await db.from("manager_automation_settings")
    .select("manual_payments,row_data").eq("manager_user_id", ownerId).maybeSingle();
  if (result.error?.message.toLowerCase().includes("manual_payments") &&
      result.error.message.toLowerCase().includes("does not exist")) {
    result = await db.from("manager_automation_settings")
      .select("row_data").eq("manager_user_id", ownerId).maybeSingle();
  }
  if (result.error || !result.data) return null;
  const stored = result.data as { manual_payments?: unknown; row_data?: { manualPayments?: unknown } | null };
  const policy = stored.manual_payments ?? stored.row_data?.manualPayments;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const enabled = (policy as { axisPaymentsEnabled?: unknown }).axisPaymentsEnabled;
  return typeof enabled === "boolean" ? enabled : null;
}

export async function resolveListingForHouseholdCharge(
  db: SupabaseClient,
  charge: HouseholdCharge,
  managerUserId: string,
): Promise<ManagerListingSubmissionV1 | null> {
  const propertyId = charge.propertyId?.trim();
  if (propertyId) {
    const { data } = await db
      .from("manager_property_records")
      .select("property_data")
      .eq("id", propertyId)
      .maybeSingle();
    const listing = listingFromPropertyData(data?.property_data);
    if (listing) return listing;
  }

  const managerId = managerUserId.trim();
  const label = displayPropertyLabel(charge.propertyLabel ?? "");
  if (!managerId || !label) return null;

  const { data: rows } = await db
    .from("manager_property_records")
    .select("property_data")
    .eq("manager_user_id", managerId)
    .limit(200);

  for (const row of rows ?? []) {
    if (listingBuildingName(row.property_data).toLowerCase() !== label.toLowerCase()) continue;
    const listing = listingFromPropertyData(row.property_data);
    if (listing) return listing;
  }

  return null;
}

export async function enrichHouseholdChargesFromPropertyRecords(
  db: SupabaseClient,
  charges: HouseholdCharge[],
): Promise<HouseholdCharge[]> {
  return (await enrichHouseholdChargesFromPropertyRecordsResult(db, charges)).charges;
}

/**
 * The same enrichment, with whether either property read actually succeeded.
 *
 * A caller that only renders a Pay button can ignore a failed read (the row
 * simply shows as not payable); a caller that GATES on payability cannot - a
 * transient read error would otherwise look exactly like "this property
 * collects offline". The at-signing gate reads `lookupFailed` and fails closed.
 */
export async function enrichHouseholdChargesFromPropertyRecordsResult(
  db: SupabaseClient,
  charges: HouseholdCharge[],
): Promise<{ charges: HouseholdCharge[]; lookupFailed: boolean }> {
  if (charges.length === 0) return { charges, lookupFailed: false };
  let lookupFailed = false;

  const propertyIds = [...new Set(charges.map((c) => c.propertyId?.trim()).filter(Boolean))] as string[];
  const listingByPropertyId = new Map<string, { ownerId: string; listing: ManagerListingSubmissionV1 | null }>();

  if (propertyIds.length > 0) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, manager_user_id, property_data")
      .in("id", propertyIds);
    if (error) lookupFailed = true;
    for (const row of data ?? []) {
      listingByPropertyId.set(String(row.id), {
        ownerId: String(row.manager_user_id ?? "").trim(),
        listing: listingFromPropertyData(row.property_data),
      });
    }
  }

  const propertylessManagerIds = [...new Set(charges.filter((c) => !c.propertyId?.trim())
    .map((c) => c.managerUserId?.trim()).filter(Boolean))] as string[];
  const accountPolicies = new Map<string, boolean | null>();
  await Promise.all(propertylessManagerIds.map(async (managerId) => {
    const policy = await resolvePropertylessManagerPaymentPolicy(db, managerId);
    if (policy === null) lookupFailed = true;
    accountPolicies.set(managerId, policy);
  }));

  const enriched = charges.map((charge) => {
    const propertyId = charge.propertyId?.trim();
    if (!propertyId) {
      const accountPolicy = accountPolicies.get(charge.managerUserId?.trim() ?? "") ?? null;
      return { ...charge, axisPaymentsEnabledSnapshot: accountPolicy,
        acceptedPaymentMethodsSnapshot: accountPolicy === null ? undefined : ["ach", "card"] as HouseholdCharge["acceptedPaymentMethodsSnapshot"] };
    }
    const property = listingByPropertyId.get(propertyId);
    // A historical co-manager may have created the charge. The property's
    // actual owner is the payee and its current listing is the policy source.
    const listing = property?.ownerId ? property.listing : null;
    return enrichHouseholdChargePaymentFlags(charge, listing);
  });
  return { charges: enriched, lookupFailed };
}
