/**
 * Management-fee math for owner-managed houses. Pure, integer cents, no I/O.
 *
 * The fee is the destination charge's `application_fee_amount` (docs/agents/owner-management.md). Every
 * function here is deterministic so a retried checkout, a webhook replay and the monthly statement all
 * arrive at the same cents.
 */

import { createHash } from "node:crypto";

export type OwnerFeeModel = "percent_of_collected" | "flat_monthly";

export type OwnerAgreementTerms = {
  feeModel: OwnerFeeModel;
  /** Hundredths of a percent of collected rent (800 = 8%). Used by `percent_of_collected`. */
  feeBps: number;
  /** Flat monthly fee in cents. Used by `flat_monthly`. */
  feeFlatCents: number;
  /** Hundredths of a percent of a lease's first routed payment, once per lease. 0 = none. */
  leasingFeeBps: number;
  /** Monthly floor in cents (never more than what was collected). 0 = none. */
  minFeeCents: number;
  /** Repairs above this need the owner's yes; at or below are auto-approved. */
  repairApprovalThresholdCents: number;
  /** Advisory reserve the owner should set aside (PropLane never holds it). */
  reserveTargetCents: number;
};

/** Charge kinds whose rent is routed to the owner. Everything else keeps the workspace flow. */
export const OWNER_ROUTED_RENT_KINDS = [
  "rent",
  "first_month_rent",
  "prorated_rent",
  "prorated_last_month_rent",
] as const;

/** The routed kinds a leasing fee may be taken from (the first payment of a new lease). */
export const OWNER_LEASING_FEE_KINDS = ["first_month_rent", "prorated_rent"] as const;

export const OWNER_FEE_LIMITS = {
  maxFeeBps: 3000,
  maxFlatCents: 500_000,
  maxLeasingBps: 10_000,
  maxMinFeeCents: 500_000,
  maxThresholdCents: 5_000_000,
  maxReserveCents: 100_000_000,
  /** Expense recoup never takes more than this share of one payment's principal. */
  recoupMaxShareBps: 5000,
} as const;

export function isOwnerRoutedRentKind(kind: string): boolean {
  return (OWNER_ROUTED_RENT_KINDS as readonly string[]).includes(kind);
}

export function isOwnerLeasingFeeKind(kind: string): boolean {
  return (OWNER_LEASING_FEE_KINDS as readonly string[]).includes(kind);
}

function exactNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Round-half-up integer division of non-negative integers. */
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  if (!exactNonNegative(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("Fee math needs non-negative integer cents.");
  }
  // numerator is at most ~1e11 (cents * 1e4), well inside 2^53.
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/** Validate agreement terms; returns the first problem or null. */
export function validateOwnerAgreementTerms(terms: OwnerAgreementTerms): string | null {
  const L = OWNER_FEE_LIMITS;
  if (terms.feeModel !== "percent_of_collected" && terms.feeModel !== "flat_monthly") return "Pick a fee model.";
  if (!exactNonNegative(terms.feeBps) || terms.feeBps > L.maxFeeBps) return "The percentage fee must be between 0% and 30%.";
  if (!exactNonNegative(terms.feeFlatCents) || terms.feeFlatCents > L.maxFlatCents) return "The monthly fee must be between $0 and $5,000.";
  if (terms.feeModel === "percent_of_collected" && terms.feeBps <= 0) return "Enter the percentage fee.";
  if (terms.feeModel === "flat_monthly" && terms.feeFlatCents <= 0) return "Enter the monthly fee.";
  if (!exactNonNegative(terms.leasingFeeBps) || terms.leasingFeeBps > L.maxLeasingBps) return "The leasing fee must be between 0% and 100%.";
  if (!exactNonNegative(terms.minFeeCents) || terms.minFeeCents > L.maxMinFeeCents) return "The minimum fee must be between $0 and $5,000.";
  if (!exactNonNegative(terms.repairApprovalThresholdCents) || terms.repairApprovalThresholdCents > L.maxThresholdCents) {
    return "The repair approval amount must be between $0 and $50,000.";
  }
  if (!exactNonNegative(terms.reserveTargetCents) || terms.reserveTargetCents > L.maxReserveCents) return "The reserve target is out of range.";
  return null;
}

/** What the monthly fee should total once `cumPrincipal` has been collected in the month. */
export function targetMonthlyFeeCents(terms: OwnerAgreementTerms, cumPrincipal: number): number {
  if (!exactNonNegative(cumPrincipal)) throw new Error("Collected rent must be non-negative cents.");
  if (cumPrincipal === 0) return 0;
  const base =
    terms.feeModel === "flat_monthly"
      ? Math.min(terms.feeFlatCents, cumPrincipal)
      : roundHalfUpDiv(cumPrincipal * terms.feeBps, 10_000);
  const floor = Math.min(terms.minFeeCents, cumPrincipal);
  return Math.min(Math.max(base, floor), cumPrincipal);
}

/**
 * The most the month's cumulative fee may ever be for `cumPrincipal` collected (monthly part only, plus
 * `leasingCents` actually taken). The reservation RPC enforces the same bound in SQL, so a caller bug
 * cannot take more than the agreement allows.
 */
export function maxCumulativeFeeCents(terms: OwnerAgreementTerms, cumPrincipal: number, leasingCents: number): number {
  const monthly = targetMonthlyFeeCents(terms, cumPrincipal);
  return Math.min(cumPrincipal, monthly + Math.max(0, leasingCents));
}

export type ManagementFeeInput = {
  terms: OwnerAgreementTerms;
  /** Routed principal already collected (settled or reserved), net of refunds, this Pacific month. */
  cumPrincipalBefore: number;
  /** Monthly fee already taken (settled or reserved), net of fee refunds, this Pacific month. Leasing excluded. */
  monthlyFeeTakenBefore: number;
  /** This cart's routed principal. */
  principal: number;
  /** Part of `principal` that is the first payment of a new lease (leasing-fee kinds). 0 when none or already charged. */
  leasingPrincipal: number;
};

export type ManagementFee = {
  monthlyFeeCents: number;
  leasingFeeCents: number;
  totalCents: number;
};

export function computeManagementFee(input: ManagementFeeInput): ManagementFee {
  const { terms, cumPrincipalBefore, monthlyFeeTakenBefore, principal, leasingPrincipal } = input;
  if (![cumPrincipalBefore, monthlyFeeTakenBefore, principal, leasingPrincipal].every(exactNonNegative)) {
    throw new Error("Fee math needs non-negative integer cents.");
  }
  if (principal <= 0) return { monthlyFeeCents: 0, leasingFeeCents: 0, totalCents: 0 };
  if (leasingPrincipal > principal) throw new Error("Leasing principal cannot exceed the payment.");
  const cumAfter = cumPrincipalBefore + principal;
  const rawMonthly = targetMonthlyFeeCents(terms, cumAfter) - monthlyFeeTakenBefore;
  const monthly = Math.min(Math.max(rawMonthly, 0), principal);
  const leasingRaw = leasingPrincipal > 0 && terms.leasingFeeBps > 0 ? roundHalfUpDiv(leasingPrincipal * terms.leasingFeeBps, 10_000) : 0;
  // The owner always nets something: the whole fee can never reach the payment.
  const leasing = Math.min(leasingRaw, Math.max(principal - monthly - 1, 0));
  const total = monthly + leasing;
  return { monthlyFeeCents: monthly, leasingFeeCents: leasing, totalCents: total };
}

/**
 * Spread a cart's fee over its charges (largest remainder, ties by id) so each allocation row carries
 * an exact share and the shares sum to the fee.
 */
export function allocateFeeAcrossCharges(
  parts: ReadonlyArray<{ id: string; principalCents: number }>,
  totalFeeCents: number,
): Array<{ id: string; feeCents: number }> {
  const sorted = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  const principal = sorted.reduce((sum, p) => sum + p.principalCents, 0);
  if (sorted.length === 0 || principal <= 0 || !exactNonNegative(totalFeeCents) || totalFeeCents > principal) {
    throw new Error("Cannot spread this fee over the cart.");
  }
  const shares = sorted.map((p) => ({
    base: Math.floor((totalFeeCents * p.principalCents) / principal),
    remainder: (totalFeeCents * p.principalCents) % principal,
  }));
  let residue = totalFeeCents - shares.reduce((sum, s) => sum + s.base, 0);
  const rank = sorted
    .map((_, index) => index)
    .sort((a, b) => shares[b]!.remainder - shares[a]!.remainder || sorted[a]!.id.localeCompare(sorted[b]!.id));
  for (const index of rank) {
    if (residue-- <= 0) break;
    shares[index]!.base += 1;
  }
  return sorted.map((p, index) => ({ id: p.id, feeCents: shares[index]!.base }));
}

/**
 * Stripe refunds a PROPORTIONAL share of the application fee when `refund_application_fee` is set
 * (a full refund returns the whole fee). We mirror that so the books predict Stripe's own number; the
 * refund event's actual application-fee refund is what gets stored, this is the cross-check.
 */
export function feeRefundCents(feeCents: number, principalCents: number, refundCents: number): number {
  if (![feeCents, principalCents, refundCents].every(exactNonNegative) || principalCents <= 0) {
    throw new Error("Fee refund needs non-negative integer cents.");
  }
  if (refundCents > principalCents) throw new Error("A refund cannot exceed the payment.");
  if (refundCents === principalCents) return feeCents;
  return roundHalfUpDiv(feeCents * refundCents, principalCents);
}

/** How much of a payment may go to expense recoup: bounded by outstanding and by the owner-share cap. */
export function computeExpenseRecoupCents(input: {
  outstandingApprovedCents: number;
  principal: number;
  managementFeeCents: number;
  ownerBornProcessingCents: number;
}): number {
  const { outstandingApprovedCents, principal, managementFeeCents, ownerBornProcessingCents } = input;
  if (![outstandingApprovedCents, principal, managementFeeCents, ownerBornProcessingCents].every(exactNonNegative)) {
    throw new Error("Recoup math needs non-negative integer cents.");
  }
  const cap = Math.floor((principal * OWNER_FEE_LIMITS.recoupMaxShareBps) / 10_000);
  const room = Math.max(principal - managementFeeCents - ownerBornProcessingCents - 1, 0);
  return Math.max(0, Math.min(outstandingApprovedCents, cap, room));
}

export type OwnerNetBreakdown = {
  principalCents: number;
  managementFeeCents: number;
  ownerBornProcessingCents: number;
  expenseRecoupCents: number;
  ownerNetCents: number;
};

export function ownerNetBreakdown(input: Omit<OwnerNetBreakdown, "ownerNetCents">): OwnerNetBreakdown {
  const net = input.principalCents - input.managementFeeCents - input.ownerBornProcessingCents - input.expenseRecoupCents;
  if (![input.principalCents, input.managementFeeCents, input.ownerBornProcessingCents, input.expenseRecoupCents].every(exactNonNegative) || net <= 0) {
    throw new Error("The owner's share must stay positive.");
  }
  return { ...input, ownerNetCents: net };
}

/** The Pacific calendar month `YYYY-MM` of an instant (the same month every money view uses). */
export function pacificMonthKey(at: Date | string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date.");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

export function previousMonthKey(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new Error("Invalid month.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** Canonical text of the terms an owner signs, and its hash. Changing a term changes the hash. */
export function canonicalAgreementTerms(input: {
  propertyId: string;
  ownerUserId: string;
  terms: OwnerAgreementTerms;
  startsOn: string;
  endsOn: string | null;
}): string {
  const t = input.terms;
  return JSON.stringify({
    v: 1,
    propertyId: input.propertyId,
    ownerUserId: input.ownerUserId,
    feeModel: t.feeModel,
    feeBps: t.feeBps,
    feeFlatCents: t.feeFlatCents,
    leasingFeeBps: t.leasingFeeBps,
    minFeeCents: t.minFeeCents,
    repairApprovalThresholdCents: t.repairApprovalThresholdCents,
    reserveTargetCents: t.reserveTargetCents,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
  });
}

export function agreementTermsSha256(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Plain-English fee line used in texts and the owner portal. No subtext, no emoji. */
export function describeOwnerFee(terms: OwnerAgreementTerms): string {
  const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
  const core = terms.feeModel === "flat_monthly" ? `${money(terms.feeFlatCents)} a month` : `${pct(terms.feeBps)} of rent collected`;
  const extras = [
    terms.leasingFeeBps > 0 ? `${pct(terms.leasingFeeBps)} leasing fee` : "",
    terms.minFeeCents > 0 ? `${money(terms.minFeeCents)} monthly minimum` : "",
  ].filter(Boolean);
  return extras.length ? `${core}, ${extras.join(", ")}` : core;
}
