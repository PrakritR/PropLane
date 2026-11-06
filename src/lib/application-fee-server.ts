import "server-only";

import { parseMoneyAmount } from "@/lib/parse-money";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

function listingFromPropertyData(propertyData: unknown): ManagerListingSubmissionV1 | null {
  if (!propertyData || typeof propertyData !== "object") return null;
  const submission = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!submission || typeof submission !== "object") return null;
  if ((submission as { v?: unknown }).v !== 1) return null;
  return normalizeManagerListingSubmissionV1(submission as ManagerListingSubmissionV1);
}

function rawApplicationFeeLabel(propertyData: unknown): string {
  if (!propertyData || typeof propertyData !== "object") return "";
  const submission = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!submission || typeof submission !== "object") return "";
  return String((submission as { applicationFee?: unknown }).applicationFee ?? "").trim();
}

/** Server-side application fee in USD cents from a property row's `property_data`. */
export function applicationFeeCentsFromPropertyData(propertyData: unknown): number {
  const raw = rawApplicationFeeLabel(propertyData);
  if (!raw) {
    const listing = listingFromPropertyData(propertyData);
    if (!listing) return 0;
    const amount = parseMoneyAmount(listing.applicationFee ?? "");
    return amount > 0 ? Math.round(amount * 100) : 0;
  }
  const amount = parseMoneyAmount(raw);
  if (amount <= 0) return 0;
  return Math.round(amount * 100);
}
