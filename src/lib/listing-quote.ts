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
  listingFeeCadence,
  listingFeesForWizard,
  type ListingFeeRow,
} from "@/lib/listing-fees";
import {
  PAYMENT_AT_SIGNING_FEE_KEY_PREFIX,
  PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX,
  feeAppliesToLeaseType,
  feeAppliesToRoom,
  isPaymentDueAtSigning,
} from "@/lib/listing-fee-scope";
import { listingFoldsAllMonthlyFeesIntoRent } from "@/lib/seattle-rent-rule";
import { SHORT_TERM_LEASE_TERM, AIRBNB_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/** One line on the move-in receipt. */
export type ListingQuoteLine = {
  /** The signing-matrix key this line is ticked by, so the panel can write it back. */
  key: string;
  label: string;
  note?: string;
  amount: number;
  dueAtSigning: boolean;
};

export type ListingQuoteFee = { id: string; label: string; amount: number };

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
  return fee.presetId === "security_deposit" || Boolean(fee.creditsTowardSecurity);
}

/** Is this term priced per night / per stay rather than per month? */
export function isStayLeaseTerm(leaseTerm: string | null | undefined): boolean {
  const term = String(leaseTerm ?? "").trim();
  return term === SHORT_TERM_LEASE_TERM || term === AIRBNB_LEASE_TERM;
}

function roomRentForTerm(room: ManagerRoomSubmission, leaseTerm: string): number {
  const override = room.termPricing?.[leaseTerm]?.monthlyRent;
  if (typeof override === "number" && Number.isFinite(override)) return override;
  return room.monthlyRent || 0;
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
  const override = room.termPricing?.[leaseTerm]?.securityDeposit;
  if ((override ?? "").trim()) return parseMoneyAmount(override ?? "");
  if ((room.securityDeposit ?? "").trim()) return parseMoneyAmount(room.securityDeposit ?? "");
  return parseMoneyAmount(sub.securityDeposit ?? "");
}

function roomUtilitiesForTerm(room: ManagerRoomSubmission, leaseTerm: string): number {
  const override = room.termPricing?.[leaseTerm]?.utilitiesEstimate;
  if ((override ?? "").trim()) return parseMoneyAmount(override ?? "");
  return parseMoneyAmount(room.utilitiesEstimate ?? "");
}

/**
 * Build the receipt for one room on one lease type.
 *
 * `roomId` null quotes the whole place — an entire-home listing, where the
 * listing's own rent stands in for a room's.
 */
export function buildListingQuote(
  sub: ManagerListingSubmissionV1,
  options: { roomId?: string | null; leaseTerm: string },
): ListingQuote {
  const leaseTerm = String(options.leaseTerm ?? "").trim();
  const isStay = isStayLeaseTerm(leaseTerm);
  const rooms = sub.rooms ?? [];
  const room = options.roomId ? rooms.find((r) => r.id === options.roomId) ?? null : null;
  const roomId = room?.id ?? null;

  const baseMonthlyRent = room
    ? roomRentForTerm(room, leaseTerm)
    : (sub.entireHomeMonthlyRent ?? 0) || (rooms[0] ? roomRentForTerm(rooms[0], leaseTerm) : 0);
  const monthlyUtilities = isStay ? 0 : room ? roomUtilitiesForTerm(room, leaseTerm) : 0;
  const securityDeposit = room
    ? roomDepositForTerm(room, leaseTerm, sub, isStay)
    : parseMoneyAmount(sub.securityDeposit ?? "");

  const applicable = listingFeesForWizard(sub).filter(
    (fee) => feeAppliesToLeaseType(fee, leaseTerm) && feeAppliesToRoom(fee, roomId),
  );

  const foldMonthlyIntoRent = listingFoldsAllMonthlyFeesIntoRent(sub);
  const recurring: ListingQuoteFee[] = [];
  const folded: ListingQuoteFee[] = [];
  const oneTime: ListingFeeRow[] = [];
  const applicationFees: ListingQuoteFee[] = [];

  for (const fee of applicable) {
    const amount = amountForTerm(fee, isStay);
    if (amount <= 0) continue;
    // The deposit is its own line on the receipt, never a fee line as well.
    if (fee.presetId === "security_deposit") continue;
    if (fee.presetId === "holding_deposit") {
      applicationFees.push({ id: fee.id, label: feeLabel(fee), amount });
      continue;
    }
    const cadence = listingFeeCadence(fee);
    if (cadence === "monthly") {
      const entry = { id: fee.id, label: feeLabel(fee), amount };
      if (foldMonthlyIntoRent || fee.includeInRent) folded.push(entry);
      else recurring.push(entry);
      continue;
    }
    oneTime.push(fee);
  }

  const applicationFee = parseMoneyAmount(sub.applicationFee ?? "");
  if (applicationFee > 0) {
    applicationFees.unshift({ id: "application_fee", label: "Application fee", amount: applicationFee });
  }

  const foldedTotal = folded.reduce((sum, f) => sum + f.amount, 0);
  const monthlyRent = baseMonthlyRent + foldedTotal;
  const recurringTotal = recurring.reduce((sum, f) => sum + f.amount, 0);
  const monthlyTotal = monthlyRent + monthlyUtilities + recurringTotal;

  const rentKey = roomId
    ? `${PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX}${roomId}`
    : "first_month_rent";
  const rentDueAtSigning =
    isPaymentDueAtSigning(sub, rentKey, leaseTerm) ||
    (Boolean(roomId) && isPaymentDueAtSigning(sub, "first_month_rent", leaseTerm));

  /*
   * The first month's line carries the recurring fees that also fall due in
   * month one. A resident hands over rent AND parking on day one; showing only
   * rent here and parking under "then each month" quotes a move-in cost that is
   * short by a month of fees.
   */
  const firstPeriodExtras = [...folded, ...recurring];
  const signingLines: ListingQuoteLine[] = [
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
  ];
  if (!isStay && monthlyUtilities > 0) {
    signingLines.push({
      key: "first_month_utilities",
      label: "First month utilities",
      amount: monthlyUtilities,
      dueAtSigning: isPaymentDueAtSigning(sub, "first_month_utilities", leaseTerm),
    });
  }
  if (securityDeposit > 0) {
    signingLines.push({
      key: "security_deposit",
      label: "Security deposit",
      note: "Refundable",
      amount: securityDeposit,
      dueAtSigning: isPaymentDueAtSigning(sub, "security_deposit", leaseTerm),
    });
  }
  for (const fee of oneTime) {
    const key = signingKeyForFee(fee);
    signingLines.push({
      key,
      label: feeLabel(fee),
      note: isRefundable(fee) ? "Refundable" : "Non-refundable",
      amount: amountForTerm(fee, isStay),
      dueAtSigning: isPaymentDueAtSigning(sub, key, leaseTerm),
    });
  }

  const signingTotal = signingLines.filter((l) => l.dueAtSigning).reduce((sum, l) => sum + l.amount, 0);
  const nonRefundableAtSigning = oneTime
    .filter((fee) => !isRefundable(fee))
    .reduce((sum, fee) => sum + amountForTerm(fee, isStay), 0);

  const nightly = room
    ? parseMoneyAmount(room.shortTermRent ?? "") || room.dailyRentPrice || 0
    : parseMoneyAmount(sub.shortTermDailyCost ?? "");
  const weekly = room?.weeklyRentPrice ?? 0;

  return {
    leaseTerm,
    roomId,
    roomName: room?.name?.trim() || "Whole place",
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
    securityDeposit,
    nonRefundableAtSigning,
  };
}
