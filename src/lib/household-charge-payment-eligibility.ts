import type { HouseholdCharge } from "@/lib/household-charges";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { acceptedPaymentMethodsForListing, axisPaymentsEnabledOnListing } from "@/lib/payment-policy";
import { getPropertyById } from "@/lib/rental-application/data";

export function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.split(" · ")[0]!.trim();
}

export function listingFromPropertyData(propertyData: unknown): ManagerListingSubmissionV1 | null {
  if (!propertyData || typeof propertyData !== "object") return null;
  const submission = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!submission || typeof submission !== "object") return null;
  if ((submission as { v?: unknown }).v !== 1) return null;
  // Some older/test property rows carry only a partial v1 payload. They are
  // not a trustworthy payment-policy source, and the normalizer requires these
  // collections. A malformed unrelated listing must not break a paid charge's
  // reminder cleanup or a resident's charge list.
  if (!Array.isArray((submission as { rooms?: unknown }).rooms) ||
      !Array.isArray((submission as { bathrooms?: unknown }).bathrooms)) return null;
  return normalizeManagerListingSubmissionV1(submission as ManagerListingSubmissionV1);
}

export function listingBuildingName(propertyData: unknown): string {
  if (!propertyData || typeof propertyData !== "object") return "";
  const row = propertyData as { buildingName?: string; listingSubmission?: { buildingName?: string } };
  return displayPropertyLabel(row.listingSubmission?.buildingName ?? row.buildingName ?? "");
}

export function paymentSnapshotsFromListing(
  listing: ManagerListingSubmissionV1 | null,
): Pick<
  HouseholdCharge,
  "axisPaymentsEnabledSnapshot" | "acceptedPaymentMethodsSnapshot"
> {
  if (!listing) {
    return {};
  }
  const sub = normalizeManagerListingSubmissionV1(listing);
  return {
    axisPaymentsEnabledSnapshot: axisPaymentsEnabledOnListing(sub),
    acceptedPaymentMethodsSnapshot: acceptedPaymentMethodsForListing(sub),
  };
}

export function enrichHouseholdChargePaymentFlags(
  charge: HouseholdCharge,
  listing: ManagerListingSubmissionV1 | null,
): HouseholdCharge {
  const snapshots = paymentSnapshotsFromListing(listing);
  return {
    ...charge,
    // The creation snapshot is historical. A server read must expose the
    // current owned-listing policy and clear stale flags when it cannot be read.
    axisPaymentsEnabledSnapshot: snapshots.axisPaymentsEnabledSnapshot ?? null,
    acceptedPaymentMethodsSnapshot: snapshots.acceptedPaymentMethodsSnapshot,
  };
}

export function canPayHouseholdChargeWithAxisAch(charge: HouseholdCharge): boolean {
  return householdChargeProplanePayability(charge) === "payable";
}

/**
 * Can the resident pay this line in PropLane?
 *
 *  - `payable`  — PropLane payments are on for the listing. An unready payout account uses a platform hold.
 *  - `offline`  — the listing says PropLane payments are off.
 *  - `unknown`  — the listing could not be resolved at all (a failed property read,
 *    or a record carrying no `v === 1` listing submission).
 *
 * `unknown` is NOT `offline`. {@link canPayHouseholdChargeWithAxisAch} collapses
 * the two because every UI caller only ever offers or hides a Pay button, but the
 * at-signing gate must tell them apart: treating "cannot determine" as "collects
 * offline" let a signature through with the lease fee, deposit and move-in fee
 * still owed.
 */
export function householdChargeProplanePayability(
  charge: HouseholdCharge,
): "payable" | "offline" | "unknown" {
  if (charge.status === "paid") return "offline";
  if (charge.axisPaymentsEnabledSnapshot === null) return "unknown";
  if (charge.axisPaymentsEnabledSnapshot === true) return "payable";
  if (charge.axisPaymentsEnabledSnapshot === false) return "offline";

  const prop = getPropertyById(charge.propertyId);
  const sub =
    prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  if (!sub) return "unknown";
  return axisPaymentsEnabledOnListing(sub) ? "payable" : "offline";
}
