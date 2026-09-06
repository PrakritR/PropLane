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
import { isEntireHomeListing, resolveAllowedLeaseTerms, type ManagerListingSubmissionV1, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import type { ManagerSkuTier } from "@/lib/manager-access";
import {
  listingPaymentWaiverCodeMatches,
} from "@/lib/payment-policy";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

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
  return (
    room.monthlyRent > 0 ||
    (room.rentBasis === "daily" && (room.dailyRentPrice ?? 0) > 0) ||
    (room.rentBasis === "weekly" && (room.weeklyRentPrice ?? 0) > 0)
  );
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
    if (!isEditMode) {
      if (!sub.listingPropertyTypeId?.trim()) errs.listingPropertyTypeId = "Choose a property type.";
      if (!sub.listingStoriesId?.trim()) errs.listingStoriesId = "Select how many floors or levels the home has.";
      if (!sub.listingTotalBathroomsId?.trim()) errs.listingTotalBathroomsId = "Select how many bathrooms the home has.";
      if (!sub.listingBedroomSlots || sub.listingBedroomSlots < 1) {
        errs.listingBedroomSlots = "Select how many bedrooms you will list for rent.";
      }
    }
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

    if (
      sub.serviceFeePayer === "proplane" &&
      !listingPaymentWaiverCodeMatches(sub.serviceFeeWaiverCode)
    ) {
      errs.serviceFeeWaiverCode = "Enter a valid waiver code (FREE100).";
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
