import { isValidZipInput } from "@/lib/listing-form-inputs";
// buildListingStepFieldOrder reads this; without the import it throws a
// ReferenceError the moment the wizard tries to scroll to its first invalid field.
import { LISTING_STEP_FIELD_ORDER } from "@/lib/wizard-field-errors";
import { validateStateAbbrev } from "@/app/(public)/rent/apply/apply-validation";
import {
  deriveListingLtFeeToggles,
  validateListingLtFeeToggles,
  validateListingStFeeToggles,
  type ListingLtFeeToggles,
  type ListingStFeeToggles,
} from "@/lib/listing-fee-term-toggles";
import { validateListingBundleShortTermPricing } from "@/lib/listing-bundle-short-term";
import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/parse-money";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { AIRBNB_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { roomHasStayOffer } from "@/lib/room-pricing";
import { normalizeWorkspacePricingDefaults, workspaceDefaultRentForRoom } from "@/lib/workspace-pricing-defaults";
import type { ManagerSkuTier } from "@/lib/manager-access";
import {
  LISTING_PROCESSING_FEE_PROPLANE_NOT_ALLOWED,
  managerCanSelectProplaneServiceFee,
} from "@/lib/payment-policy";
import { isProcessingCoverageCodeShape } from "@/lib/processing-coverage-codes";

export function listingRoomNameKey(roomId: string): string {
  return `room-${roomId}-name`;
}

export function listingRoomRentKey(roomId: string): string {
  return `room-${roomId}-rent`;
}

/** Separate key from {@link listingRoomRentKey} so the error lands on the daily rate input, not monthly rent. */
export function listingRoomDailyRentKey(roomId: string): string {
  return `room-${roomId}-daily-rent`;
}

export function listingRoomWeeklyRentKey(roomId: string): string {
  return `room-${roomId}-weekly-rent`;
}

/**
 * A room is priced when it carries a monthly rent OR an explicit daily/weekly rate. Every
 * gate that asks "does this room have a price?" must use this, so a daily-only room
 * that passes step validation is not rejected later by a monthly-only check.
 */
export function listingRoomHasRent(room: ManagerRoomSubmission): boolean {
  const nightly = parseMoneyAmount(room.shortTermRent ?? "");
  const weekly = room.weeklyRentPrice ?? 0;
  return (
    room.monthlyRent > 0 ||
    (nightly != null && nightly > 0) ||
    weekly > 0 ||
    (room.rentBasis === "daily" && (room.dailyRentPrice ?? 0) > 0) ||
    (room.rentBasis === "weekly" && weekly > 0)
  );
}

function roomMonthlyRentForTerm(room: ManagerRoomSubmission, term: string): number {
  const override = room.termPricing?.[term]?.monthlyRent;
  if (typeof override === "number" && override > 0) return override;
  if (room.monthlyRent > 0) return room.monthlyRent;
  return 0;
}

function listingHasRentForAllowedTerm(sub: ManagerListingSubmissionV1, term: string): boolean {
  if (term === SHORT_TERM_LEASE_TERM) {
    return sub.rooms.some((room) => roomHasStayOffer(room));
  }
  if (term === AIRBNB_LEASE_TERM) {
    if (isEntireHomeListing(sub)) return entireHomeMonthlyRentAmount(sub) > 0;
    return sub.rooms.some((room) => {
      const nightly = parseMoneyAmount(room.shortTermRent ?? "");
      return nightly != null && nightly > 0;
    });
  }
  if (isEntireHomeListing(sub)) return entireHomeMonthlyRentAmount(sub) > 0;
  return sub.rooms.some((room) => roomMonthlyRentForTerm(room, term) > 0);
}

/** The two reasons Publish can refuse for pricing. Lease type is set on Rooms (Leases offered); rent is set on the property's Pricing tab. */
export const PUBLISH_BLOCKER_LEASE_TYPE = "Choose a lease type before publishing.";
export const PUBLISH_BLOCKER_RENT = "Add a rent before publishing.";

/** V2 listing publish — offered lease types must carry a real price (pricing moved off the wizard rail, studio redesign 0929). */
export function listingV2PublishPricingBlocker(
  sub: ManagerListingSubmissionV1,
  rawDefaults?: unknown,
): string | null {
  const allowed = resolveAllowedLeaseTerms(sub);
  if (allowed.length === 0) return PUBLISH_BLOCKER_LEASE_TYPE;
  if (allowed.some((term) => listingHasRentForAllowedTerm(sub, term))) return null;

  const defaults = normalizeWorkspacePricingDefaults(rawDefaults);
  const normalized = normalizeManagerListingSubmissionV1(sub);
  for (const room of normalized.rooms) {
    if (!room.name.trim() && room.monthlyRent <= 0) continue;
    if (room.monthlyRent > 0) continue;
    const cap = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
    if (workspaceDefaultRentForRoom(defaults, cap)) return null;
  }
  if (normalized.entireHomeOffered && entireHomeMonthlyRentAmount(normalized) <= 0 && (defaults.rentWhole ?? 0) > 0) {
    return null;
  }
  return PUBLISH_BLOCKER_RENT;
}

export function listingBathroomNameKey(bathId: string): string {
  return `bathroom-${bathId}-name`;
}

export function listingSharedSpaceNameKey(spaceId: string): string {
  return `shared-${spaceId}-name`;
}

export function listingCustomQuestionErrorKey(fieldId: string): string {
  return `appq-${fieldId}`;
}

export type ListingWizardValidateOptions = {
  isEditMode?: boolean;
  entireHomeRent?: number;
  /** ST fee checkbox state from the unified Fees table (defaults derived from submission). */
  stFeeToggles?: ListingStFeeToggles;
  /** LT fee checkbox state from the unified Fees table (defaults derived from submission). */
  ltFeeToggles?: ListingLtFeeToggles;
  managerSkuTier?: ManagerSkuTier;
  /** Account-level FREE100 (or other) waiver from manager_purchases.promo_code. */
  accountPaymentWaiverGranted?: boolean;
};

export function validateListingWizardStep(
  stepIndex: number,
  sub: ManagerListingSubmissionV1,
  opts: ListingWizardValidateOptions = {},
): Record<string, string> {
  const errs: Record<string, string> = {};
  const isEditMode = opts.isEditMode ?? false;
  const isEntireHome = isEntireHomeListing(sub);
  const entireHomeRent = opts.entireHomeRent ?? 0;

  if (stepIndex === 0) {
    if (!sub.buildingName.trim()) errs.buildingName = "Property name is required.";
    if (!sub.address.trim()) errs.address = "Street address is required.";
    if (!sub.city.trim()) errs.city = "City is required.";
    const stateCheck = validateStateAbbrev(sub.state);
    if (!stateCheck.ok) errs.state = stateCheck.message;
    if (!sub.zip.trim()) errs.zip = "ZIP is required.";
    else if (!isValidZipInput(sub.zip)) errs.zip = "Enter a valid 5-digit ZIP or ZIP+4.";
    /*
     * "For listing only have title, pictures, price and description."
     * "There is too much on the listing."
     *
     * Floors, total bathrooms, bedroom count and property type are facts about a
     * HOUSE, not things a renter needs before a listing can exist — and three of
     * them duplicate sections (Rooms, Bathrooms) that are already optional. They
     * stay on the form, and an existing listing keeps whatever it answered; they
     * simply no longer stop a manager publishing.
     *
     * What is still required is the address, because a rental nobody can find is
     * not a listing, and the lease is written against it.
     */
  }

  if (stepIndex === 1) {
    // Room cards are auto-created from the bedroom count with default names.
    // Names can be edited; other room fields stay optional on this step.
  }

  if (stepIndex === 2) {
    // Bathroom cards are auto-created from the bathroom count with default names.
  }

  if (stepIndex === 3) {
    // Shared spaces are fully optional — blank rows are dropped on submit.
  }

  if (stepIndex === 4) {
    if (!sub.listingPlaceCategoryId?.trim()) {
      errs.listingPlaceCategoryId = "Select how this property is rented (individual rooms or entire place).";
    }
    const allowedTerms = resolveAllowedLeaseTerms(sub);
    const longTermTerms = allowedTerms.filter((t) => t !== SHORT_TERM_LEASE_TERM);
    const hasLongTerm = longTermTerms.length > 0;
    const hasShortTerm = Boolean(sub.shortTermRentalsAllowed);

    if (allowedTerms.length === 0) errs.allowedLeaseTerms = "Select at least one lease term, short-term stays, or Airbnb.";

    const ltToggles = opts.ltFeeToggles ?? deriveListingLtFeeToggles(sub);

    if (hasLongTerm) {
      Object.assign(
        errs,
        validateListingLtFeeToggles(sub, ltToggles, true, { isEntireHome, entireHomeRent }),
      );
      if (ltToggles.rent && !isEntireHome) {
        const anyRent = sub.rooms.some(listingRoomHasRent);
        if (!anyRent && sub.rooms.length > 0) {
          errs.monthlyRent = "Set a monthly, weekly, or daily rent for at least one room (leave others at 0 if not offered).";
        }
        for (const room of sub.rooms) {
          if (room.rentBasis === "daily" && !((room.dailyRentPrice ?? 0) > 0)) {
            errs[listingRoomDailyRentKey(room.id)] = "Enter a daily rent rate, or turn off daily pricing.";
          }
          if (room.rentBasis === "weekly" && !((room.weeklyRentPrice ?? 0) > 0)) {
            errs[listingRoomWeeklyRentKey(room.id)] = "Enter a weekly rent rate, or turn off weekly pricing.";
          }
        }
      }
    }

    if (hasShortTerm && opts.stFeeToggles) {
      Object.assign(errs, validateListingStFeeToggles(sub, opts.stFeeToggles, true));
    }
    Object.assign(errs, validateListingBundleShortTermPricing(sub));

    if (sub.serviceFeePayer === "proplane") {
      const tier = opts.managerSkuTier ?? "free";
      /*
       * Either source satisfies it: the account's grant, or a code of the right
       * SHAPE on this listing.
       *
       * Shape, not validity — deciding validity needs the coverage codes, and
       * this runs in the browser, where holding them is exactly the bug that let
       * a manager read one out of a client chunk. A well-formed code gets the
       * manager past publish-readiness; the write path re-derives it server-side
       * and downgrades the listing to `resident` if it is not real, so a wrong
       * code costs PropLane nothing.
       */
      const granted =
        opts.accountPaymentWaiverGranted === true ||
        isProcessingCoverageCodeShape(sub.serviceFeeWaiverCode);
      if (!managerCanSelectProplaneServiceFee(tier, granted)) {
        // The error sits on the payer field: that is the control the manager changed.
        errs.serviceFeePayer = LISTING_PROCESSING_FEE_PROPLANE_NOT_ALLOWED;
      }
    }
    // Resident payment methods (Stripe ACH / card) are configured in Payment setup.
  }

  return errs;
}

/** Field scroll order for a step — static keys first, then per-row keys in list order. */
export function buildListingStepFieldOrder(stepIndex: number, sub: ManagerListingSubmissionV1): string[] {
  const base = [...(LISTING_STEP_FIELD_ORDER[stepIndex] ?? [])];
  if (stepIndex === 1) {
    return [...sub.rooms.map((r) => listingRoomNameKey(r.id)), "rooms"];
  }
  if (stepIndex === 2) {
    return [...sub.bathrooms.map((b) => listingBathroomNameKey(b.id)), "bathrooms"];
  }
  if (stepIndex === 3) {
    return [...sub.sharedSpaces.map((s) => listingSharedSpaceNameKey(s.id)), "sharedSpaces"];
  }
  if (stepIndex === 4 && !isEntireHomeListing(sub)) {
    const rentKeys = sub.rooms.flatMap((r) => [
      listingRoomRentKey(r.id),
      listingRoomDailyRentKey(r.id),
      listingRoomWeeklyRentKey(r.id),
    ]);
    const monthlyIdx = base.indexOf("monthlyRent");
    if (monthlyIdx === -1) return [...rentKeys, ...base];
    return [...base.slice(0, monthlyIdx + 1), ...rentKeys, ...base.slice(monthlyIdx + 1)];
  }
  return base;
}

/** First step (in order) that fails validation, or null if all pass through `lastStep`. */
export function firstInvalidListingStep(
  sub: ManagerListingSubmissionV1,
  opts: ListingWizardValidateOptions,
  lastStep = 4,
): { stepIndex: number; errors: Record<string, string> } | null {
  for (let i = 0; i <= lastStep; i++) {
    const errors = validateListingWizardStep(i, sub, opts);
    if (Object.keys(errors).length > 0) return { stepIndex: i, errors };
  }
  return null;
}
