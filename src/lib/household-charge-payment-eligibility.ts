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
  "axisPaymentsEnabledSnapshot" | "zelleContactSnapshot" | "venmoContactSnapshot" | "acceptedPaymentMethodsSnapshot"
> {
  if (!listing) {
    return {};
  }
  const sub = normalizeManagerListingSubmissionV1(listing);
  return {
    axisPaymentsEnabledSnapshot: axisPaymentsEnabledOnListing(sub),
    zelleContactSnapshot:
      sub.zellePaymentsEnabled && sub.zelleContact?.trim() ? sub.zelleContact.trim() : undefined,
    venmoContactSnapshot:
      sub.venmoPaymentsEnabled && sub.venmoContact?.trim() ? sub.venmoContact.trim() : undefined,
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
    axisPaymentsEnabledSnapshot:
      charge.axisPaymentsEnabledSnapshot ?? snapshots.axisPaymentsEnabledSnapshot,
    zelleContactSnapshot: charge.zelleContactSnapshot ?? snapshots.zelleContactSnapshot,
    venmoContactSnapshot: charge.venmoContactSnapshot ?? snapshots.venmoContactSnapshot,
    acceptedPaymentMethodsSnapshot: snapshots.acceptedPaymentMethodsSnapshot ?? charge.acceptedPaymentMethodsSnapshot,
  };
}

export function canPayHouseholdChargeWithAxisAch(charge: HouseholdCharge): boolean {
  if (charge.status === "paid") return false;
  if (charge.managerStripeConnectReadySnapshot === false) return false;
  if (charge.axisPaymentsEnabledSnapshot === true) return true;
  if (charge.axisPaymentsEnabledSnapshot === false) return false;

  const prop = getPropertyById(charge.propertyId);
  const sub =
    prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  return Boolean(sub && axisPaymentsEnabledOnListing(sub));
}
