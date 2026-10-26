import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import { parseRoomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { resolveStayPricing } from "@/lib/room-pricing";
import { shortTermStayCanBePriced, shortTermStayNightCount } from "@/lib/short-term-stay-pricing";

export const SHORT_STAY_PRICING_INCOMPLETE_MESSAGE = "Set a nightly rate that covers the full stay, or choose whole weeks for a weekly-only rate, before approving or sending the lease.";

/**
 * What the loader found, so the manager is told something they can act on. `null` is the property's rates missing
 * (set them), not a failure: a read that failed is `unreadable` (retry) and a stay naming no property is `unplaced`
 * (assign the room). `undefined` means the caller did not load one and falls back to its own copy.
 */
export type ShortStayPricingSubmission = ManagerListingSubmissionV1 | null | undefined | "unreadable" | "unplaced";

export type ShortStayPricingPlacement = {
  propertyId?: string | null;
  assignedPropertyId?: string | null;
  roomChoice?: string | null;
  assignedRoomChoice?: string | null;
  application?: Partial<RentalWizardFormState> | null;
  signedMonthlyRent?: number | null;
};

/** Bundles keep their separate existing pricing path; this guard covers room/whole-home stays. */
export function needsShortStayPricingCheck(row: ShortStayPricingPlacement): boolean {
  return row.application?.rentalType === "short_term" && !row.application.bundleId?.trim();
}

/** Same rates and night coverage as the quote, agreement and approval ledger. No monthly fallback. */
export function shortStayPricingBlocker(row: ShortStayPricingPlacement, submission: ShortStayPricingSubmission): string | null {
  if (!needsShortStayPricingCheck(row)) return null;
  if (submission === "unreadable") return "Could not verify the stay pricing. Try again in a moment.";
  if (submission === "unplaced") return "This stay is not linked to a property yet. Assign the room before approving or sending the lease.";
  if (!submission) return "This property has no stay rates. Set a nightly or weekly rate before approving or sending the lease.";
  const app = row.application!;
  const choice = row.assignedRoomChoice || row.roomChoice || app.roomChoice1 || "";
  const room = resolveSubmissionRoom(submission, { roomChoices: [choice] });
  const pricing = resolveStayPricing({ room, submission, application: {
    ...app,
    residentSlot: app.residentSlot ?? parseRoomChoiceValue(choice).residentSlot,
    signedMonthlyRent: row.signedMonthlyRent,
  } });
  const start = parseFlexibleLocalDate(app.leaseStart);
  const end = parseFlexibleLocalDate(app.leaseEnd);
  const nights = start && end && end > start ? shortTermStayNightCount(app.leaseStart, app.leaseEnd) : null;
  if (!nights) return "Set valid check-in and check-out dates before approving or sending the lease.";
  return shortTermStayCanBePriced(pricing.dailyRate ?? 0, nights, pricing.weeklyRate) ? null : SHORT_STAY_PRICING_INCOMPLETE_MESSAGE;
}
