import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** Raw per-listing application fee label before manager-default fallback. */
export function listingApplicationFeeRaw(
  listing: ManagerListingSubmissionV1 | null | undefined,
  rentalType?: "standard" | "short_term",
): string {
  if (!listing) return "";
  if (rentalType === "short_term") {
    const st = String(listing.shortTermApplicationFee ?? "").trim();
    if (st !== "") return st;
    return String(listing.applicationFee ?? "").trim();
  }
  return String(listing.applicationFee ?? "").trim();
}
