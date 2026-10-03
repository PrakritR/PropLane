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
import { getStripe } from "@/lib/stripe";
import { validateManagerConnectForDestinationCharge } from "@/lib/stripe-connect";

async function managerStripeConnectReadyByManagerId(
  db: SupabaseClient,
  managerIds: string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (managerIds.length === 0) return out;

  const { data: profiles } = await db
    .from("profiles")
    .select("id, stripe_connect_account_id")
    .in("id", managerIds);

  let stripe: ReturnType<typeof getStripe> | null = null;
  try {
    stripe = getStripe();
  } catch {
    stripe = null;
  }

  for (const row of profiles ?? []) {
    const id = String(row.id ?? "").trim();
    const accountId = String(
      (row as { stripe_connect_account_id?: string | null }).stripe_connect_account_id ?? "",
    ).trim();
    if (!id) continue;
    if (!accountId) {
      out.set(id, false);
      continue;
    }
    if (!stripe) {
      out.set(id, true);
      continue;
    }
    const result = await validateManagerConnectForDestinationCharge(stripe, accountId);
    out.set(id, result.ok);
  }

  return out;
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
  const listingByPropertyId = new Map<string, ManagerListingSubmissionV1 | null>();

  if (propertyIds.length > 0) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, property_data")
      .in("id", propertyIds);
    if (error) lookupFailed = true;
    for (const row of data ?? []) {
      listingByPropertyId.set(String(row.id), listingFromPropertyData(row.property_data));
    }
  }

  const managerIds = [...new Set(charges.map((c) => c.managerUserId?.trim()).filter(Boolean))] as string[];
  const listingsByManager = new Map<string, Array<{ buildingName: string; listing: ManagerListingSubmissionV1 | null }>>();
  const connectReadyByManager = await managerStripeConnectReadyByManagerId(db, managerIds);

  if (managerIds.length > 0) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("manager_user_id, property_data")
      .in("manager_user_id", managerIds)
      .limit(500);
    if (error) lookupFailed = true;
    for (const row of data ?? []) {
      const managerId = String(row.manager_user_id ?? "").trim();
      if (!managerId) continue;
      const bucket = listingsByManager.get(managerId) ?? [];
      bucket.push({
        buildingName: listingBuildingName(row.property_data),
        listing: listingFromPropertyData(row.property_data),
      });
      listingsByManager.set(managerId, bucket);
    }
  }

  const enriched = charges.map((charge) => {
    const managerId = charge.managerUserId?.trim() ?? "";
    let listing = listingByPropertyId.get(charge.propertyId?.trim() ?? "") ?? null;
    if (!listing) {
      const label = displayPropertyLabel(charge.propertyLabel ?? "").toLowerCase();
      if (label && managerId) {
        listing =
          listingsByManager.get(managerId)?.find((row) => row.buildingName.toLowerCase() === label)?.listing ??
          null;
      }
    }
    return {
      ...enrichHouseholdChargePaymentFlags(charge, listing),
      managerStripeConnectReadySnapshot: managerId ? connectReadyByManager.get(managerId) : undefined,
    };
  });
  return { charges: enriched, lookupFailed };
}
