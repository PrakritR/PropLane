import type { ApplicationFeeChargePolicy } from "@/lib/manager-application-settings";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

type ListingFeePolicySource = Pick<
  ManagerListingSubmissionV1,
  "waiveApplicationFeeForReturningResidents" | "applicationFeeOnlyFirstApplication"
>;

/**
 * Per-listing repeat-applicant policy. When the listing sets nothing, callers
 * fall back to the manager account default (`applicationFeeChargePolicy`).
 */
export function listingApplicationFeeChargePolicy(
  listing: ListingFeePolicySource | null | undefined,
): ApplicationFeeChargePolicy | undefined {
  if (listing?.waiveApplicationFeeForReturningResidents === true) return "first_only";
  if (listing?.waiveApplicationFeeForReturningResidents === false) return "every_time";
  if (listing?.applicationFeeOnlyFirstApplication === true) return "first_only";
  return undefined;
}

export function resolveApplicationFeeChargePolicy(
  listing: ListingFeePolicySource | null | undefined,
  managerPolicy: ApplicationFeeChargePolicy,
): ApplicationFeeChargePolicy {
  return listingApplicationFeeChargePolicy(listing) ?? managerPolicy;
}
