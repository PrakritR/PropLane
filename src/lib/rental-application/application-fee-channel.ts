import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** How the applicant pays the application fee. `stripe` is a legacy alias for `ach`. */
export type ApplicationFeePayChannel = "ach" | "stripe";

export function listingApplicationFeeChannels(sub: ManagerListingSubmissionV1 | undefined): {
  ach: boolean;
  /** @deprecated Use `ach` — kept for older saved form state. */
  stripe: boolean;
} {
  const ach = sub?.axisPaymentsEnabled !== false;
  return { ach, stripe: ach };
}

/** There is one channel; the listing and any saved preference no longer change it. */
export function resolveApplicationFeePayChannel(): ApplicationFeePayChannel {
  return "ach";
}

export function isAchApplicationFeeChannel(channel: ApplicationFeePayChannel): boolean {
  return channel === "ach" || channel === "stripe";
}
