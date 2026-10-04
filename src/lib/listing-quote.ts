/**
 * What a resident actually pays, computed from a listing submission.
 *
 * The listing wizard asks for rent, a deposit, utilities, several fees and a
 * per-lease-type rule about which of those are collected before move-in — across
 * four different screens. Nothing ever added them up, so a manager could not see
 * the one number an applicant sees. This module is that addition, and only that:
 * it READS the submission and returns lines. It writes nothing and decides
 * nothing about billing.
 *
 * It is deliberately not a second pricing engine. Every rule it applies already
 * exists somewhere the ledger reads:
 *
 * - per-lease-type room prices come from {@link ManagerRoomSubmission.termPricing},
 *   absent meaning "same as long-term" (PRP-463), exactly as `resolveStayPricing` reads it;
 * - which fees bill on a lease and a room come from `feeAppliesToLeaseType` /
 *   `feeAppliesToRoom`;
 * - what is collected at signing comes from `isPaymentDueAtSigning`, the same
 *   matrix the signing table writes;
 * - in Seattle every recurring monthly fee is folded into rent rather than billed
 *   beside it, which is `listingFoldsAllMonthlyFeesIntoRent`.
 *
 * If any of those change, this follows them. It must never grow a rule of its own.
 */

import { parseMoneyAmount } from "@/lib/parse-money";
import {
  feeAppliesToResidentSlot,
  isListingFeeAmountFilled,
  listingFeeCadence,
  listingFeeMonthlyEquivalent,
  listingFeesForWizard,
  type ListingFeeCadence,
  type ListingFeeRow,
} from "@/lib/listing-fees";
import { feeAppliesToArrangementCount } from "@/lib/listing-fees";
import { roomPriceForResidentCount } from "@/lib/room-arrangement-pricing";
import { roomResidentPriceForSlot, roomStayPriceForSlot } from "@/lib/room-pricing";
import {
  PAYMENT_AT_SIGNING_FEE_KEY_PREFIX,
  PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX,
  feeAppliesToLeaseType,
  feeAppliesToRoom,
  isPaymentDueAtSigning,
} from "@/lib/listing-fee-scope";
import { listingFoldsAllMonthlyFeesIntoRent } from "@/lib/seattle-rent-rule";
import { resolvePlacementStandardFees } from "@/lib/listing-placement-standard-fees";
import { houseDefaultsForSubmission, roomInheritsDefault } from "@/lib/listing-house-defaults";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM, AIRBNB_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { isEntireHomeListing, type ManagerListingSubmissionV1, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/** One line on the move-in receipt. */
export type ListingQuoteLine = {
  /** The signing-matrix key this line is ticked by, so the panel can write it back. */
  key: string;
  label: string;
  note?: string;
  amount: number;
  dueAtSigning: boolean;
};

export type ListingQuoteFee = { id: string; label: string; amount: number; cadence?: ListingFeeCadence };

export type ListingQuote = {
  leaseTerm: string;
  roomId: string | null;
  roomName: string;
  /** True for short-term / nightly terms, where the rate is all-in and there is no utilities line. */
  isStay: boolean;
  monthlyRent: number;
  monthlyUtilities: number;
  /** Recurring fees that bill beside rent. Empty in Seattle, where they fold into it. */
  monthlyFees: ListingQuoteFee[];
  /** Recurring fees folded INTO the rent figure (Seattle), already included in monthlyRent. */
  foldedIntoRent: ListingQuoteFee[];
  monthlyTotal: number;
  nightlyRate: number | null;
  weeklyRate: number | null;
  signingLines: ListingQuoteLine[];
  signingTotal: number;
  /** Paid when applying, never at signing. */
  applicationFees: ListingQuoteFee[];
  securityDeposit: number;
  /** One-time signing fees that are not refundable — the number a deposit cap cares about. */
  nonRefundableAtSigning: number;
};

/**
 * The receipt's two blocks. A line is "at signing" exactly when the signing matrix collects it
 * (the same `dueAtSigning` the total sums, which is the same stamp the pay-before-signing charges
 * carry), so a line is never listed inside the signing block while the total ignores it.
 */
export function splitQuoteLinesBySigning(quote: Pick<ListingQuote, "signingLines">): {
  atSigning: ListingQuoteLine[];
  later: ListingQuoteLine[];
} {
  return {
    atSigning: quote.signingLines.filter((l) => l.dueAtSigning),
    later: quote.signingLines.filter((l) => !l.dueAtSigning),
  };
}

function amountForTerm(fee: ListingFeeRow, isStay: boolean): number {
  if (isStay && (fee.shortTermAmount ?? "").trim()) return parseMoneyAmount(fee.shortTermAmount ?? "");
  return parseMoneyAmount(fee.amount ?? "");
}

function feeLabel(fee: ListingFeeRow): string {
  return fee.label?.trim() || "Fee";
}

/** The signing-matrix key a fee row is ticked by. Presets have their own standard keys. */
function signingKeyForFee(fee: ListingFeeRow): string {
  if (fee.presetId === "security_deposit") return "security_deposit";
  if (fee.presetId === "move_in_fee") return "move_in_fee";
  return `${PAYMENT_AT_SIGNING_FEE_KEY_PREFIX}${fee.id}`;
}

/** A fee a resident never gets back. Only these count against a move-in cap. */
function isRefundable(fee: ListingFeeRow): boolean {
  return (
    fee.presetId === "security_deposit" ||
    Boolean(fee.refundable) ||
    Boolean(fee.creditsTowardSecurity)
  );
}

/** Is this term priced per night / per stay rather than per month? */
export function isStayLeaseTerm(leaseTerm: string | null | undefined): boolean {
  const term = String(leaseTerm ?? "").trim();
  return term === SHORT_TERM_LEASE_TERM || term === AIRBNB_LEASE_TERM;
}

/** Long-term is the base row; per-term overrides live on other lease tabs only. */
function isBaseLeaseTerm(leaseTerm: string): boolean {
  return leaseTerm === LONG_TERM_LEASE_TERM;
}

function roomRentForTerm(
  room: ManagerRoomSubmission,
  leaseTerm: string,
  sub: ManagerListingSubmissionV1,
): number {
  if (!isBaseLeaseTerm(leaseTerm)) {
    const override = room.termPricing?.[leaseTerm]?.monthlyRent;
    if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  }
  const defaults = houseDefaultsForSubmission(sub);
  if (isBaseLeaseTerm(leaseTerm) && roomInheritsDefault(room, defaults, "monthlyRent") && defaults.monthlyRent > 0) {
    return defaults.monthlyRent;
  }
  if (room.monthlyRent > 0) return room.monthlyRent;
  return 0;
}

function roomDepositForTerm(
  room: ManagerRoomSubmission,
  leaseTerm: string,
  sub: ManagerListingSubmissionV1,
  isStay: boolean,
): number {
  if (isStay) {
    const stay = (room.shortTermDeposit ?? "").trim();
    if (stay) return parseMoneyAmount(stay);
  }
  if (!isBaseLeaseTerm(leaseTerm)) {
    const override = room.termPricing?.[leaseTerm]?.securityDeposit;
    if ((override ?? "").trim()) return parseMoneyAmount(override ?? "");
  }
  const defaults = houseDefaultsForSubmission(sub);
  if (isBaseLeaseTerm(leaseTerm) && roomInheritsDefault(room, defaults, "securityDeposit") && (defaults.securityDeposit ?? "").trim()) {
    return parseMoneyAmount(defaults.securityDeposit);
  }
  if ((room.securityDeposit ?? "").trim()) return parseMoneyAmount(room.securityDeposit ?? "");
  if ((defaults.securityDeposit ?? "").trim()) return parseMoneyAmount(defaults.securityDeposit);
  return parseMoneyAmount(sub.securityDeposit ?? "");
}

function roomUtilitiesForTerm(
  room: ManagerRoomSubmission,
  leaseTerm: string,
  sub: ManagerListingSubmissionV1,
): number {
  if (!isBaseLeaseTerm(leaseTerm)) {
    const override = room.termPricing?.[leaseTerm]?.utilitiesEstimate;
    if ((override ?? "").trim()) return parseMoneyAmount(override ?? "");
  }
  const defaults = houseDefaultsForSubmission(sub);
  if (isBaseLeaseTerm(leaseTerm) && roomInheritsDefault(room, defaults, "utilitiesEstimate") && (defaults.utilitiesEstimate ?? "").trim()) {
    return parseMoneyAmount(defaults.utilitiesEstimate);
  }
  if ((room.utilitiesEstimate ?? "").trim()) return parseMoneyAmount(room.utilitiesEstimate ?? "");
  if ((defaults.utilitiesEstimate ?? "").trim()) return parseMoneyAmount(defaults.utilitiesEstimate);
  return 0;
}

/**
 * Build the receipt for one room on one lease type.
 *
 * `roomId` null quotes the whole place — an entire-home listing, where the
 * listing's own rent stands in for a room's.
 */
export type ListingQuoteStartKind = "std" | "cst";

export function buildListingQuote(
  sub: ManagerListingSubmissionV1,
  options: {
    roomId?: string | null;
    leaseTerm: string;
    residentSlot?: number | null;
    arrangementCount?: number | null;
    startKind?: ListingQuoteStartKind;
    /** Property Pricing whole-house row — use `entireHomeMonthlyRent` even on shared-home listings. */
    useEntireHomeRent?: boolean;
  },
): ListingQuote {
  const leaseTerm = String(options.leaseTerm ?? "").trim();
  const isStay = isStayLeaseTerm(leaseTerm);
  const rooms = sub.rooms ?? [];
  const room = options.roomId ? rooms.find((r) => r.id === options.roomId) ?? null : null;
  const roomId = room?.id ?? null;
  const defaults = houseDefaultsForSubmission(sub);
  const residentSlot =
    typeof options.residentSlot === "number" && Number.isInteger(options.residentSlot) && options.residentSlot >= 1
      ? options.residentSlot
      : undefined;
  const arrangementCount =
    typeof options.arrangementCount === "number" &&
    Number.isInteger(options.arrangementCount) &&
    options.arrangementCount >= 1
      ? options.arrangementCount
      : undefined;
  const startKind: ListingQuoteStartKind = options.startKind ?? "std";
  const slotPrice = room && residentSlot ? roomResidentPriceForSlot(room, residentSlot, leaseTerm) : undefined;
  const staySlot = room && residentSlot ? roomStayPriceForSlot(room, residentSlot) : undefined;
  const arrangementPrice =
    room && arrangementCount ? roomPriceForResidentCount(room, arrangementCount) : undefined;
  const arrangementRow =
    room?.occupancyPrices?.find((row) => row.count === arrangementCount) ??
    (options.useEntireHomeRent && !room ? sub.entireHomeArrangementFees : undefined);
  const placementFees = resolvePlacementStandardFees(sub, {
    leaseTerm,
    room,
    arrangementCount,
    // An entire-home listing reads its whole-house row even before a rent view is pinned, so the
    // application fee follows the lease type with no room chosen.
    entireHomeFees: !room && (options.useEntireHomeRent || isEntireHomeListing(sub)) ? sub.entireHomeArrangementFees : undefined,
    isStay,
  });

  // A stay is priced by its own rate (night / week / the term's own price). With none set there is
  // no stay figure at all: the long-term monthly rent is never a stand-in for it.
  const nightly = staySlot
    ? parseMoneyAmount(staySlot.shortTermRent ?? "") || 0
    : room
      ? parseMoneyAmount(room.shortTermRent ?? "") || room.dailyRentPrice || 0
      : parseMoneyAmount(sub.shortTermDailyCost ?? "");
  const weekly = staySlot?.weeklyRentPrice ?? room?.weeklyRentPrice ?? 0;
  const stayTermRent = room?.termPricing?.[leaseTerm]?.monthlyRent;
  const hasStayRate =
    !isStay ||
    nightly > 0 ||
    weekly > 0 ||
    Boolean(slotPrice) ||
    (typeof stayTermRent === "number" && Number.isFinite(stayTermRent) && stayTermRent > 0);

  const baseMonthlyRent = !hasStayRate ? 0 : slotPrice
    ? slotPrice.monthlyRent
    : arrangementPrice && !isStay
      ? arrangementPrice.monthlyRent
    : room
      ? roomRentForTerm(room, leaseTerm, sub)
      : options.useEntireHomeRent && (sub.entireHomeMonthlyRent ?? 0) > 0
        ? (sub.entireHomeMonthlyRent ?? 0)
        : isEntireHomeListing(sub)
          ? (sub.entireHomeMonthlyRent ?? 0)
          : defaults.monthlyRent > 0
            ? defaults.monthlyRent
            : 0;
  const monthlyUtilities = isStay
    ? 0
    : slotPrice?.utilitiesEstimate != null && String(slotPrice.utilitiesEstimate).trim()
      ? parseMoneyAmount(slotPrice.utilitiesEstimate)
      : arrangementPrice && !isStay
        ? parseMoneyAmount(arrangementPrice.utilitiesEstimate)
      : room
        ? roomUtilitiesForTerm(room, leaseTerm, sub)
        : options.useEntireHomeRent && (sub.entireHomeUtilitiesEstimate ?? "").trim()
          ? parseMoneyAmount(sub.entireHomeUtilitiesEstimate ?? "")
          : parseMoneyAmount(defaults.utilitiesEstimate ?? "");
  const securityDeposit =
    slotPrice?.securityDeposit != null && String(slotPrice.securityDeposit).trim()
      ? parseMoneyAmount(slotPrice.securityDeposit)
      : arrangementPrice
        ? parseMoneyAmount(arrangementPrice.securityDeposit)
      : room
        ? roomDepositForTerm(room, leaseTerm, sub, isStay)
        : parseMoneyAmount((defaults.securityDeposit || sub.securityDeposit || "").trim());

  const applicable = listingFeesForWizard(sub).filter(
    (fee) =>
      feeAppliesToLeaseType(fee, leaseTerm) &&
      feeAppliesToRoom(fee, roomId) &&
      feeAppliesToResidentSlot(fee, residentSlot) &&
      feeAppliesToArrangementCount(fee, arrangementCount),
  );

  const foldMonthlyIntoRent = listingFoldsAllMonthlyFeesIntoRent(sub);
  const recurring: ListingQuoteFee[] = [];
  const folded: ListingQuoteFee[] = [];
  const oneTime: ListingFeeRow[] = [];
  const applicationFees: ListingQuoteFee[] = [];

  for (const fee of applicable) {
    const amount = amountForTerm(fee, isStay);
    /*
     * A fee the manager deliberately set to 0 is a real answer — "parking is
     * included", "no move-in fee" — and dropping it left the resident guessing.
     * An UNFILLED fee is still skipped: a blank row is a fee that was never
     * priced, not a free one. Totals are unaffected either way, since the line
     * adds zero.
     */
    if (amount < 0) continue;
    if (amount === 0 && !isListingFeeAmountFilled(fee.amount ?? "")) continue;
    // The deposit is its own line on the receipt, never a fee line as well.
    if (fee.presetId === "security_deposit") continue;
    // The stay type's own move-in replaces the house move-in row (long-term or short-term), never a second line.
    if (placementFees.moveInOverridesHouse && (fee.presetId === "move_in_fee" || fee.presetId === "short_term_move_in")) continue;
    if (fee.presetId === "holding_deposit") {
      applicationFees.push({ id: fee.id, label: feeLabel(fee), amount });
      continue;
    }
    const cadence = listingFeeCadence(fee);
    if (cadence === "monthly" || cadence === "weekly" || cadence === "daily") {
      const entry = { id: fee.id, label: feeLabel(fee), amount, cadence };
      if (cadence === "monthly" && (foldMonthlyIntoRent || fee.includeInRent)) folded.push(entry);
      else recurring.push(entry);
      continue;
    }
    oneTime.push(fee);
  }

  // Application fee: the stay type's own fee replaces the house fee -- the one resolver
  // (`placementFees`), which follows the room and lease type even before an occupancy count is
  // chosen (a known room reads its Private row, an entire-home listing its whole-house row).
  if (placementFees.applicationFee > 0) {
    applicationFees.unshift({
      id: "application_fee",
      label: "Application fee",
      amount: placementFees.applicationFee,
    });
  }

  const foldedTotal = folded.reduce((sum, f) => sum + f.amount, 0);
  let monthlyRent = baseMonthlyRent + foldedTotal;
  if (!isStay && startKind === "cst" && arrangementRow?.customStartSurcharge) {
    monthlyRent += parseMoneyAmount(arrangementRow.customStartSurcharge);
  }
  const recurringTotal = recurring.reduce(
    (sum, f) => sum + listingFeeMonthlyEquivalent(f.amount, f.cadence ?? "monthly"),
    0,
  );
  const monthlyTotal = monthlyRent + monthlyUtilities + recurringTotal;

  const rentKey = roomId
    ? `${PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX}${roomId}`
    : "first_month_rent";
  const rentDueAtSigning =
    isPaymentDueAtSigning(sub, rentKey, leaseTerm, roomId) ||
    (Boolean(roomId) && isPaymentDueAtSigning(sub, "first_month_rent", leaseTerm, roomId));

  /*
   * The first month's line carries the recurring fees that also fall due in
   * month one. A resident hands over rent AND parking on day one; showing only
   * rent here and parking under "then each month" quotes a move-in cost that is
   * short by a month of fees.
   */
  const firstPeriodExtras = [...folded, ...recurring];
  const signingLines: ListingQuoteLine[] = hasStayRate
    ? [
        {
          key: rentKey,
          label: isStay ? "First stay payment" : "First month's rent",
          note:
            firstPeriodExtras.length > 0
              ? `Includes ${firstPeriodExtras.map((f) => f.label.toLowerCase()).join(", ")}`
              : undefined,
          amount: monthlyRent + recurringTotal,
          dueAtSigning: rentDueAtSigning,
        },
      ]
    : [];
  if (!isStay && monthlyUtilities > 0) {
    signingLines.push({
      key: "first_month_utilities",
      label: "First month utilities",
      amount: monthlyUtilities,
      dueAtSigning: isPaymentDueAtSigning(sub, "first_month_utilities", leaseTerm, roomId),
    });
  }
  const securityDepositCredit = oneTime
    .filter((fee) => fee.creditsTowardSecurity)
    .reduce((sum, fee) => sum + amountForTerm(fee, isStay), 0);
  const netSecurityDeposit = Math.max(0, securityDeposit - securityDepositCredit);
  if (netSecurityDeposit > 0) {
    signingLines.push({
      key: "security_deposit",
      label: "Security deposit",
      note: securityDepositCredit > 0 ? "Refundable (after other deposit credits)" : "Refundable",
      amount: netSecurityDeposit,
      dueAtSigning: isPaymentDueAtSigning(sub, "security_deposit", leaseTerm, roomId),
    });
  }
  for (const fee of oneTime) {
    const key = signingKeyForFee(fee);
    signingLines.push({
      key,
      label: feeLabel(fee),
      note: isRefundable(fee) ? "Refundable" : "Non-refundable",
      amount: amountForTerm(fee, isStay),
      dueAtSigning: isPaymentDueAtSigning(sub, key, leaseTerm, roomId),
    });
  }
  if (placementFees.leaseFee > 0) {
    signingLines.push({
      key: "arrangement_lease_fee",
      label: "Lease fee",
      amount: placementFees.leaseFee,
      dueAtSigning: true,
    });
  }
  if (placementFees.moveInOverridesHouse && placementFees.moveInFee > 0) {
    signingLines.push({
      key: "arrangement_move_in_fee",
      label: "Move-in fee",
      note: "Non-refundable",
      amount: placementFees.moveInFee,
      dueAtSigning: isPaymentDueAtSigning(sub, "move_in_fee", leaseTerm, roomId),
    });
  }

  const signingTotal = signingLines.filter((l) => l.dueAtSigning).reduce((sum, l) => sum + l.amount, 0);
  // The stay type's move-in replaces the house one, which is non-refundable; the lease fee
  // was never counted here and still is not.
  const placementNonRefundable = placementFees.moveInOverridesHouse ? placementFees.moveInFee : 0;
  const nonRefundableAtSigning =
    oneTime.filter((fee) => !isRefundable(fee)).reduce((sum, fee) => sum + amountForTerm(fee, isStay), 0) +
    placementNonRefundable;


  return {
    leaseTerm,
    roomId,
    roomName: room
      ? residentSlot
        ? `${room.name?.trim() || "Room"} · Resident ${residentSlot}`
        : room.name?.trim() || "Room"
      : "Whole place",
    isStay,
    monthlyRent,
    monthlyUtilities,
    monthlyFees: recurring,
    foldedIntoRent: folded,
    monthlyTotal,
    nightlyRate: nightly > 0 ? nightly : null,
    weeklyRate: weekly > 0 ? weekly : null,
    signingLines,
    signingTotal,
    applicationFees,
    securityDeposit: netSecurityDeposit,
    nonRefundableAtSigning,
  };
}
