import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveManagerUserIdForProperty } from "@/lib/auth/guest-application-upsert";
import { upsertManagerCharges } from "@/lib/household-charges.server";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  effectiveApplicationFeeCents,
  loadManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import { parseMoneyAmount } from "@/lib/parse-money";

/**
 * Server-side "make sure the applicant's pending application-fee row exists".
 *
 * The apply wizard creates this row in the browser; a guest who pays through
 * Stripe before that browser write landed (PRP-428) has money arriving with no
 * charge to attach it to, so the Stripe verify/webhook path ensures one from the
 * session metadata before marking it paid.
 */

type ChargeRow = {
  id: string;
  row_data: HouseholdCharge | null;
  status: string | null;
  manager_user_id: string | null;
};

function chargeKeyPart(raw: string): string {
  // Linear pass; the edge underscores are stripped by a scan rather than a
  // `/^_+|_+$/` pattern, whose `_+$` backtracks polynomially on a run of `_`.
  const cleaned = raw.slice(0, 512).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === "_") start += 1;
  while (end > start && cleaned[end - 1] === "_") end -= 1;
  return cleaned.slice(start, end) || "unknown";
}

function applicationFeeFallbackChargeId(residentEmail: string, propertyId: string): string {
  return `hc_app_fee_${chargeKeyPart(residentEmail)}_${chargeKeyPart(propertyId)}`;
}

async function loadApplicationFeeRow(
  db: SupabaseClient,
  residentEmail: string,
  propertyId: string,
  residentUserId?: string | null,
): Promise<ChargeRow | null> {
  const email = residentEmail.trim().toLowerCase();
  const pid = propertyId.trim();
  if (!email || !pid) return null;

  const { data, error } = await db
    .from("portal_household_charge_records")
    .select("id, row_data, status, manager_user_id")
    .eq("kind", "application_fee")
    .eq("property_id", pid)
    .eq("resident_email", email)
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ChargeRow[];
  if (residentUserId) {
    const byUser = rows.find((row) => row.row_data?.residentUserId === residentUserId);
    if (byUser) return byUser;
  }
  return rows[0] ?? null;
}

type ListingLookup = {
  managerUserId: string;
  propertyLabel: string;
  sub: ManagerListingSubmissionV1;
};

async function loadListingForProperty(db: SupabaseClient, propertyId: string): Promise<ListingLookup | null> {
  const managerUserId = await resolveManagerUserIdForProperty(db, propertyId);
  if (!managerUserId) return null;

  const { data: propertyRecord, error } = await db
    .from("manager_property_records")
    .select("property_data")
    .eq("id", propertyId.trim())
    .maybeSingle();
  if (error) throw new Error(error.message);

  const propertyData =
    propertyRecord?.property_data && typeof propertyRecord.property_data === "object"
      ? (propertyRecord.property_data as Record<string, unknown>)
      : null;
  const sub = propertyData?.listingSubmission as ManagerListingSubmissionV1 | undefined;
  if (!sub || sub.v !== 1) return null;

  const propertyLabel =
    sub.address?.trim() ||
    (typeof propertyData?.title === "string" ? propertyData.title.trim() : "") ||
    sub.buildingName?.trim() ||
    "Listing";
  return { managerUserId, propertyLabel, sub };
}

export async function ensureApplicationFeeChargeRow(
  db: SupabaseClient,
  input: {
    residentEmail: string;
    propertyId: string;
    residentUserId?: string | null;
    residentName?: string;
  },
): Promise<ChargeRow | null> {
  const existing = await loadApplicationFeeRow(db, input.residentEmail, input.propertyId, input.residentUserId);
  if (existing) {
    const name = input.residentName?.trim();
    const charge = existing.row_data;
    if (name && charge && (!charge.residentName?.trim() || charge.residentName.trim() === "Applicant")) {
      const managerUserId =
        (existing.manager_user_id as string | null)?.trim() || charge.managerUserId?.trim() || "";
      if (managerUserId) {
        await upsertManagerCharges(db, managerUserId, [{ ...charge, residentName: name }]);
        return (
          (await loadApplicationFeeRow(db, input.residentEmail, input.propertyId, input.residentUserId)) ?? existing
        );
      }
    }
    return existing;
  }

  const resolved = await loadListingForProperty(db, input.propertyId);
  if (!resolved) return null;
  const { managerUserId, propertyLabel, sub } = resolved;

  const managerSettings = await loadManagerApplicationSettings(db, managerUserId);
  // Per-listing value wins ([app-fee-authority] option B); an empty string is "unset" and
  // falls back to the account-wide default. A set "0" means free and is charged as-is.
  const rawListingFee = String(sub.applicationFee ?? "").trim();
  const listingFeeCents = rawListingFee === "" ? null : Math.round(parseMoneyAmount(rawListingFee) * 100);
  const applicationFeeCents = effectiveApplicationFeeCents({
    managerFeeCents: managerSettings.applicationFeeCents,
    listingFeeCents,
  });
  const amount = applicationFeeCents / 100;
  if (amount <= 0) return null;

  const email = input.residentEmail.trim();
  const label = `$${amount.toFixed(2)}`;
  const charge: HouseholdCharge = {
    id: applicationFeeFallbackChargeId(email, input.propertyId),
    createdAt: new Date().toISOString(),
    residentEmail: email,
    residentName: input.residentName?.trim() || "Applicant",
    residentUserId: input.residentUserId ?? null,
    propertyId: input.propertyId.trim(),
    propertyLabel,
    managerUserId,
    kind: "application_fee",
    title: "Application fee",
    amountLabel: label,
    balanceLabel: label,
    status: "pending",
    blocksLeaseUntilPaid: false,
  };

  await upsertManagerCharges(db, managerUserId, [charge as unknown as Record<string, unknown>]);
  return loadApplicationFeeRow(db, email, input.propertyId, input.residentUserId);
}
