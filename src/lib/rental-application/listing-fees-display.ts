import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { normalizeManagerListingSubmissionV1, PAYMENT_AT_SIGNING_OPTIONS, isEntireHomeListing, entireHomeMonthlyRentAmount } from "@/lib/manager-listing-submission";
import { leaseDocumentFeeLines, listingPresetFeeAmount } from "@/lib/listing-fees";
import { parseMoneyAmount } from "@/lib/parse-money";
import {
  formatUtilitiesListingLine,
  resolveRoomUtilitiesPaymentModel,
  utilitiesAmountIsFixedCharge,
  utilitiesListingSummaryLabel,
} from "@/lib/listing-utilities-payment";
import { roomDailyRentPrice, roomHeadlinePriceLabel, roomIsDailyPriced, roomMonthlyEquivalent } from "@/lib/room-pricing";

export type ListingSigningComputationInput = ManagerListingSubmissionV1 | undefined;

/** Monthly rent range from all rooms with rent set (listing summary). */
export function monthlyRentListingLabel(sub: ListingSigningComputationInput): string {
  if (!sub?.v) return "—";
  const n = normalizeManagerListingSubmissionV1(sub);
  if (isEntireHomeListing(n)) {
    const rent = entireHomeMonthlyRentAmount(n);
    return rent > 0 ? `$${rent.toFixed(2)}/mo` : "—";
  }
  // Daily-priced rooms contribute their monthly-equivalent so the range stays coherent as "/mo".
  const rents = n.rooms.filter((r) => r.name.trim()).map((r) => roomMonthlyEquivalent(r)).filter((x) => x > 0);
  if (!rents.length) return "—";
  const lo = Math.min(...rents);
  const hi = Math.max(...rents);
  return lo === hi ? `$${lo.toFixed(2)}/mo` : `$${lo.toFixed(2)}–${hi.toFixed(2)}/mo`;
}

/**
 * Monthly rent for the applicant’s first-choice room when the choice includes a room id; otherwise the listing range.
 */
export function applicantFirstChoiceRentLabel(sub: ListingSigningComputationInput, roomChoice1: string): string {
  if (!sub?.v) return "—";
  const n = normalizeManagerListingSubmissionV1(sub);
  const v = roomChoice1.trim();
  const sep = LISTING_ROOM_CHOICE_SEP;
  if (v.includes(sep)) {
    const roomId = v.slice(v.indexOf(sep) + sep.length);
    const room = n.rooms.find((r) => r.id === roomId);
    if (room) {
      const daily = roomDailyRentPrice(room);
      if (daily !== undefined) return `$${daily.toFixed(2)}/day`;
      if (room.monthlyRent > 0) return `$${room.monthlyRent.toFixed(2)}/mo`;
    }
  }
  return monthlyRentListingLabel(sub);
}

/** Human-readable list of charges included in “payment due at signing” (from listing settings). */
export function paymentAtSigningIncludedLabels(sub: ListingSigningComputationInput): string {
  if (!sub?.v) return "";
  const n = normalizeManagerListingSubmissionV1(sub);
  const inc = new Set(n.paymentAtSigningIncludes ?? []);
  const labels = PAYMENT_AT_SIGNING_OPTIONS.filter((o) => inc.has(o.id)).map((o) => o.label.toLowerCase());
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]!} and ${labels[1]!}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]!}`;
}

/** Normalize fee lines for display (add $ when the listing stored a bare number). */
export function formatListingFeeDisplay(raw: string): string {
  const t = raw.trim();
  if (!t) return "—";
  if (/^\$/.test(t)) return t;
  const n = parseMoneyAmount(t);
  if (n > 0) return `$${n.toFixed(2)}`;
  return t;
}

/**
 * Price label for “Payment due at signing” from selected charge types.
 *
 * This value is NOT display-only — `submissionAmount()` in household-charges parses
 * it into a real, lease-blocking charge. So the first-month-rent component must only
 * ever use exact monthly figures; a daily-priced room's rent depends on the actual
 * day count of the month the lease starts in and is quoted in the detail copy
 * (see {@link paymentAtSigningDetailBody}) rather than folded into this number as a
 * 30-day approximation.
 */
export function paymentAtSigningPriceLabel(sub: ListingSigningComputationInput): string {
  if (!sub?.v) return "—";
  const n = normalizeManagerListingSubmissionV1(sub);
  const includes = n.paymentAtSigningIncludes ?? [];
  if (!includes.length) return "—";

  let sum = 0;
  if (includes.includes("security_deposit")) sum += listingPresetFeeAmount(n, "security_deposit");
  if (includes.includes("move_in_fee")) sum += listingPresetFeeAmount(n, "move_in_fee");
  if (includes.includes("first_month_rent")) {
    const rents = isEntireHomeListing(n)
      ? [entireHomeMonthlyRentAmount(n)].filter((x) => x > 0)
      : n.rooms.filter((r) => !roomIsDailyPriced(r)).map((r) => r.monthlyRent).filter((x) => x > 0);
    if (rents.length) sum += Math.min(...rents);
  }
  if (includes.includes("first_month_utilities")) {
    const u = n.rooms.map((r) => parseMoneyAmount(r.utilitiesEstimate ?? "")).filter((x) => x > 0);
    if (u.length) sum += Math.min(...u);
  }

  if (sum <= 0) return includes.length ? "Amount TBD — confirm with manager" : "—";
  return `$${sum.toFixed(2)}`;
}

/** Dollar amounts for a placed resident — used by leases and the charge ledger. */
export type LeaseSigningAmounts = {
  securityDeposit: number;
  moveInFee: number;
  monthlyRent: number;
  monthlyUtilities: number;
  proratedRent?: number;
  proratedUtilities?: number;
  /** One-time custom fees that bill before move-in. */
  customOneTimeFees?: number;
  otherSigningCost?: number;
};

/**
 * Total due at signing for a specific placement, honoring the listing's
 * `paymentAtSigningIncludes` checkboxes (not every fee on the listing).
 */
export function computeLeasePaymentAtSigning(
  sub: ListingSigningComputationInput,
  amounts: LeaseSigningAmounts,
): number {
  const legacyFallback = () =>
    amounts.securityDeposit +
    amounts.moveInFee +
    (amounts.customOneTimeFees ?? 0) +
    (amounts.otherSigningCost ?? 0);

  if (!sub?.v) return legacyFallback();
  const n = normalizeManagerListingSubmissionV1(sub);
  const includes = n.paymentAtSigningIncludes ?? [];
  if (!includes.length) return legacyFallback();

  let sum = 0;
  if (includes.includes("security_deposit")) sum += amounts.securityDeposit;
  if (includes.includes("move_in_fee")) sum += amounts.moveInFee;
  if (includes.includes("first_month_rent")) {
    const rent =
      amounts.proratedRent != null && amounts.proratedRent > 0 ? amounts.proratedRent : amounts.monthlyRent;
    sum += rent;
  }
  if (includes.includes("first_month_utilities")) {
    const util =
      amounts.proratedUtilities != null && amounts.proratedUtilities > 0
        ? amounts.proratedUtilities
        : amounts.monthlyUtilities;
    sum += util;
  }
  sum += amounts.customOneTimeFees ?? 0;
  sum += amounts.otherSigningCost ?? 0;
  return sum;
}

/** Detail copy for listing / lease when explaining signing charges. */
export function paymentAtSigningDetailBody(sub: ListingSigningComputationInput): string {
  if (!sub?.v) return "Confirm amounts and timing with the property manager.";
  const n = normalizeManagerListingSubmissionV1(sub);
  const includes = n.paymentAtSigningIncludes ?? [];
  if (!includes.length) return "Confirm payment due at signing with the property manager.";

  const parts: string[] = [];
  if (includes.includes("security_deposit")) {
    const dep = listingPresetFeeAmount(n, "security_deposit");
    parts.push(`Security deposit (${dep > 0 ? `$${dep.toFixed(2)}` : n.securityDeposit.trim() || "—"}).`);
  }
  if (includes.includes("move_in_fee")) {
    const moveIn = listingPresetFeeAmount(n, "move_in_fee");
    parts.push(`Move-in fee (${moveIn > 0 ? `$${moveIn.toFixed(2)}` : n.moveInFee.trim() || "—"}).`);
  }
  if (includes.includes("first_month_rent")) {
    const rents = isEntireHomeListing(n)
      ? [entireHomeMonthlyRentAmount(n)].filter((x) => x > 0)
      : n.rooms.filter((r) => !roomIsDailyPriced(r)).map((r) => r.monthlyRent).filter((x) => x > 0);
    parts.push(
      rents.length
        ? isEntireHomeListing(n)
          ? `First month rent ($${Math.min(...rents).toFixed(2)} for the entire home).`
          : `First month rent (from $${Math.min(...rents).toFixed(2)} / month depending on room).`
        : isEntireHomeListing(n)
          ? "First month rent (set the entire-home rent on the listing)."
          : "First month rent (set room rent amounts on the listing).",
    );
    // Daily-priced rooms are quoted by their rate: the first month's amount depends on
    // how many days that month actually has, so it is never a fixed listing figure.
    const dailyRates = n.rooms.map((r) => roomDailyRentPrice(r)).filter((x): x is number => x !== undefined);
    if (dailyRates.length && !isEntireHomeListing(n)) {
      parts.push(
        `Rooms priced by the day bill from $${Math.min(...dailyRates).toFixed(2)} / day × the number of days in the first month.`,
      );
    }
  }
  if (includes.includes("first_month_utilities")) {
    const u = n.rooms.map((r) => parseMoneyAmount(r.utilitiesEstimate ?? "")).filter((x) => x > 0);
    parts.push(
      u.length
        ? `First month utilities (estimate from $${Math.min(...u).toFixed(2)} / month by room).`
        : "First month utilities (enter an estimate per room under Rooms).",
    );
  }
  return parts.join(" ");
}

/** Single-line utilities summary for listing cards (per-room estimates). */
export function utilitiesListingEstimateLabel(sub: ManagerListingSubmissionV1 | undefined): string {
  return utilitiesListingSummaryLabel(sub);
}

/** Multi-line detail: each room’s utilities estimate. */
export function utilitiesListingEstimateDetail(sub: ManagerListingSubmissionV1 | undefined): string {
  if (!sub?.v) return "Utilities TBD.";
  const n = normalizeManagerListingSubmissionV1(sub);
  const lines = n.rooms
    .filter((r) => r.name.trim())
    .map(
      (r) =>
        `${r.name.trim()}: ${
          formatUtilitiesListingLine(resolveRoomUtilitiesPaymentModel(r), r.utilitiesEstimate) || "—"
        }`,
    );
  return lines.length ? lines.join("\n") : "Utilities TBD.";
}

function roomSecurityDepositAmount(room: ManagerRoomSubmission, sub: ManagerListingSubmissionV1): number {
  const roomDep = parseMoneyAmount(room.securityDeposit ?? "");
  if (roomDep > 0) return roomDep;
  return parseMoneyAmount(sub.securityDeposit ?? "");
}

function roomMoveInFeeAmount(room: ManagerRoomSubmission, sub: ManagerListingSubmissionV1): number {
  const roomFee = parseMoneyAmount(room.moveInFee ?? "");
  if (roomFee > 0) return roomFee;
  return parseMoneyAmount(sub.moveInFee ?? "");
}

function roomMonthlyUtilitiesAmount(room: ManagerRoomSubmission): number {
  // Variable utilities have no fixed monthly figure to add to a total — the
  // stored amount is an estimate for disclosure, not a charge.
  if (!utilitiesAmountIsFixedCharge(resolveRoomUtilitiesPaymentModel(room))) return 0;
  return parseMoneyAmount(room.utilitiesEstimate ?? "");
}

function listingOneTimeCustomFeesTotal(sub: ManagerListingSubmissionV1): number {
  return (sub.customFees ?? [])
    .filter((fee) => {
      const presetId = (fee as { presetId?: string }).presetId;
      if (presetId && presetId !== "custom") return false;
      if (fee.frequency !== "one-time") return false;
      return parseMoneyAmount(fee.amount ?? "") > 0;
    })
    .reduce((sum, fee) => sum + parseMoneyAmount(fee.amount ?? ""), 0);
}

/** Per-room payment due at signing from listing checkboxes (no proration — lease dates unknown). */
export function listingRoomPaymentAtSigningAmount(
  room: ManagerRoomSubmission,
  sub: ManagerListingSubmissionV1,
): number {
  const n = normalizeManagerListingSubmissionV1(sub);
  return computeLeasePaymentAtSigning(n, {
    securityDeposit: roomSecurityDepositAmount(room, n),
    moveInFee: roomMoveInFeeAmount(room, n),
    monthlyRent: roomIsDailyPriced(room) ? 0 : room.monthlyRent,
    monthlyUtilities: roomMonthlyUtilitiesAmount(room),
    customOneTimeFees: listingOneTimeCustomFeesTotal(n),
  });
}

/** Collapsed pricing-step summary for one room row (rent, utilities, deposit, signing total). */
export function listingRoomPricingSummaryLabel(room: ManagerRoomSubmission, sub: ManagerListingSubmissionV1): string {
  const n = normalizeManagerListingSubmissionV1(sub);
  const parts: string[] = [];

  const rentLabel = roomHeadlinePriceLabel(room);
  if (rentLabel && rentLabel !== "—") parts.push(rentLabel);

  const utilModel = resolveRoomUtilitiesPaymentModel(room);
  const utilLine = formatUtilitiesListingLine(utilModel, room.utilitiesEstimate);
  if (utilLine && utilLine !== "—") parts.push(utilLine);

  const dep = roomSecurityDepositAmount(room, n);
  if (dep > 0) parts.push(`$${dep % 1 === 0 ? dep : dep.toFixed(2)} deposit`);

  const moveIn = roomMoveInFeeAmount(room, n);
  if (moveIn > 0) parts.push(`$${moveIn % 1 === 0 ? moveIn : moveIn.toFixed(2)} move-in`);

  const signing = listingRoomPaymentAtSigningAmount(room, n);
  if (signing > 0) {
    parts.push(`$${signing % 1 === 0 ? signing : signing.toFixed(2)} at signing`);
  }

  return parts.length ? parts.join(" · ") : "Rent not set";
}

/** Active long-term "Other fees" preset/custom lines for wizard preview copy. */
export function listingOtherFeesPreviewLines(sub: ManagerListingSubmissionV1): string[] {
  const { oneTime, monthly } = leaseDocumentFeeLines(sub, "long-term");
  const lines: string[] = [];
  for (const fee of oneTime) {
    const amount = parseMoneyAmount(fee.amount);
    if (amount > 0) lines.push(`${fee.label.trim() || "Fee"}: $${amount % 1 === 0 ? amount : amount.toFixed(2)} (one-time)`);
  }
  for (const fee of monthly) {
    const amount = parseMoneyAmount(fee.amount);
    if (amount > 0) lines.push(`${fee.label.trim() || "Fee"}: $${amount % 1 === 0 ? amount : amount.toFixed(2)}/mo`);
  }
  return lines;
}
