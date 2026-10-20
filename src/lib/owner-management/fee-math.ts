/**
 * PropLane's cut of a managed workspace's rent. Pure, integer cents, no I/O.
 *
 * Captain: "say rent is $1000, can set payment to property owner to be 90% of rent and proplane take 10%". The
 * policy stores the owner's share in basis points; PropLane's fee is the rest, ROUNDED DOWN, and the owner gets the
 * remainder. The month's cumulative figure is what is floored, so partial payments sum to exactly one floor.
 */

import { createHash } from "node:crypto";

export type FeeAppliesTo = "rent" | "all";

export type ManagedFeeTerms = {
  /** The owner's share of distributable rent in basis points (9000 = 90%). PropLane keeps `10000 - ownerShareBps`. */
  ownerShareBps: number;
  appliesTo: FeeAppliesTo;
  /** Basis points of a lease's first routed payment, once per resident per policy. 0 = none. */
  leasingFeeBps: number;
  /** Monthly floor in cents (never more than what was collected). 0 = none. */
  minFeeCents: number;
  /** Advisory reserve the owner leaves in the account before withdrawing. */
  reserveTargetCents: number;
  /** Vendor bills above this need the owner's yes; at or below post automatically. */
  repairApprovalThresholdCents: number;
};

export const MANAGED_FEE_LIMITS = {
  minOwnerShareBps: 5000,
  maxOwnerShareBps: 10_000,
  maxLeasingBps: 10_000,
  maxMinFeeCents: 500_000,
  maxReserveCents: 100_000_000,
  maxThresholdCents: 5_000_000,
} as const;

/** Charge kinds that count as rent for `appliesTo = "rent"`. */
export const RENT_KINDS = ["rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent"] as const;
/** The routed kinds a leasing fee may be taken from (the first payment of a new lease). */
export const LEASING_FEE_KINDS = ["first_month_rent", "prorated_rent"] as const;
/** Kinds that are tenant deposits: held in `tenant_deposit_liability`, never split, never withdrawable. */
export const DEPOSIT_KINDS = ["security_deposit", "holding_deposit"] as const;

export function isRentKind(kind: string): boolean {
  return (RENT_KINDS as readonly string[]).includes(kind);
}
export function isLeasingFeeKind(kind: string): boolean {
  return (LEASING_FEE_KINDS as readonly string[]).includes(kind);
}
export function isDepositKind(kind: string): boolean {
  return (DEPOSIT_KINDS as readonly string[]).includes(kind);
}

/** Does the management fee apply to a charge of this kind under this policy? Deposits never carry a fee. */
export function feeAppliesToKind(terms: Pick<ManagedFeeTerms, "appliesTo">, kind: string): boolean {
  if (isDepositKind(kind)) return false;
  return terms.appliesTo === "all" ? true : isRentKind(kind);
}

function nonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** PropLane's share in basis points. */
export function feeBpsOf(terms: Pick<ManagedFeeTerms, "ownerShareBps">): number {
  return 10_000 - terms.ownerShareBps;
}

/** Round-half-up integer division of non-negative integers. */
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  if (!nonNegativeInt(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("Fee math needs non-negative integer cents.");
  }
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/** Floor division of non-negative integers (the fee rounds down). */
export function floorDiv(numerator: number, denominator: number): number {
  if (!nonNegativeInt(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("Fee math needs non-negative integer cents.");
  }
  return Math.floor(numerator / denominator);
}

/** Validate policy terms; returns the first problem or null. */
export function validateManagedFeeTerms(terms: ManagedFeeTerms): string | null {
  const L = MANAGED_FEE_LIMITS;
  if (!Number.isSafeInteger(terms.ownerShareBps) || terms.ownerShareBps < L.minOwnerShareBps || terms.ownerShareBps > L.maxOwnerShareBps) {
    return "The owner's share must be between 50% and 100%.";
  }
  if (terms.appliesTo !== "rent" && terms.appliesTo !== "all") return "Choose what the fee applies to.";
  if (!nonNegativeInt(terms.leasingFeeBps) || terms.leasingFeeBps > L.maxLeasingBps) return "The leasing fee must be between 0% and 100%.";
  if (!nonNegativeInt(terms.minFeeCents) || terms.minFeeCents > L.maxMinFeeCents) return "The monthly minimum must be between $0 and $5,000.";
  if (!nonNegativeInt(terms.reserveTargetCents) || terms.reserveTargetCents > L.maxReserveCents) return "The reserve target is out of range.";
  if (!nonNegativeInt(terms.repairApprovalThresholdCents) || terms.repairApprovalThresholdCents > L.maxThresholdCents) {
    return "The repair approval amount must be between $0 and $50,000.";
  }
  return null;
}

/** What the month's monthly fee should total once `cumBase` of fee-applicable rent has been distributed. */
export function targetMonthlyFeeCents(terms: ManagedFeeTerms, cumBase: number): number {
  if (!nonNegativeInt(cumBase)) throw new Error("Collected rent must be non-negative cents.");
  if (cumBase === 0) return 0;
  const percent = floorDiv(cumBase * feeBpsOf(terms), 10_000);
  const floor = Math.min(terms.minFeeCents, cumBase);
  return Math.min(Math.max(percent, floor), cumBase);
}

export type CartFeeInput = {
  terms: ManagedFeeTerms;
  /** Fee-applicable distributable already collected this Pacific month, net of refunds. */
  cumBaseBefore: number;
  /** Monthly fee already taken this Pacific month (leasing excluded), net of fee refunds. */
  monthlyFeeTakenBefore: number;
  /** This cart's fee-applicable distributable. */
  applicableBase: number;
  /** Part of `applicableBase` that is a lease's first payment and has not carried a leasing fee. */
  leasingBase: number;
};

export type CartFee = { monthlyFeeCents: number; leasingFeeCents: number; totalCents: number };

export function computeCartFee(input: CartFeeInput): CartFee {
  const { terms, cumBaseBefore, monthlyFeeTakenBefore, applicableBase, leasingBase } = input;
  if (![cumBaseBefore, monthlyFeeTakenBefore, applicableBase, leasingBase].every(nonNegativeInt)) {
    throw new Error("Fee math needs non-negative integer cents.");
  }
  if (applicableBase === 0) return { monthlyFeeCents: 0, leasingFeeCents: 0, totalCents: 0 };
  if (leasingBase > applicableBase) throw new Error("Leasing base cannot exceed the fee-applicable amount.");
  const raw = targetMonthlyFeeCents(terms, cumBaseBefore + applicableBase) - monthlyFeeTakenBefore;
  const monthly = Math.min(Math.max(raw, 0), applicableBase);
  const leasingRaw = leasingBase > 0 && terms.leasingFeeBps > 0 ? floorDiv(leasingBase * terms.leasingFeeBps, 10_000) : 0;
  const leasing = Math.min(leasingRaw, applicableBase - monthly);
  return { monthlyFeeCents: monthly, leasingFeeCents: leasing, totalCents: monthly + leasing };
}

/**
 * Spread a total over parts proportionally to their weight, rounding down and giving the remainder to the largest
 * remainders (ties by id), so shares always sum exactly to `total`.
 */
export function spreadByWeight(
  parts: ReadonlyArray<{ id: string; weight: number }>,
  total: number,
): Array<{ id: string; cents: number }> {
  const sorted = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  const weight = sorted.reduce((sum, p) => sum + p.weight, 0);
  if (!nonNegativeInt(total)) throw new Error("Cannot spread a negative amount.");
  if (total === 0) return sorted.map((p) => ({ id: p.id, cents: 0 }));
  if (sorted.length === 0 || weight <= 0 || total > weight) throw new Error("Cannot spread this amount over the cart.");
  const shares = sorted.map((p) => ({
    base: Math.floor((total * p.weight) / weight),
    remainder: (total * p.weight) % weight,
  }));
  let residue = total - shares.reduce((sum, s) => sum + s.base, 0);
  const rank = sorted
    .map((_, index) => index)
    .sort((a, b) => shares[b]!.remainder - shares[a]!.remainder || sorted[a]!.id.localeCompare(sorted[b]!.id));
  for (const index of rank) {
    if (residue-- <= 0) break;
    shares[index]!.base += 1;
  }
  return sorted.map((p, index) => ({ id: p.id, cents: shares[index]!.base }));
}

/**
 * Spread a total like `spreadByWeight`, but never hand a part more than its own `cap`. Cents a cap frees go to the
 * parts that still have room, so the result is the largest total the caps allow and never more than `total`.
 */
export function spreadByWeightCapped(
  parts: ReadonlyArray<{ id: string; weight: number; cap: number }>,
  total: number,
): Array<{ id: string; cents: number }> {
  const sorted = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  if (!nonNegativeInt(total)) throw new Error("Cannot spread a negative amount.");
  if (total === 0 || sorted.length === 0) return sorted.map((p) => ({ id: p.id, cents: 0 }));
  const capOf = new Map(sorted.map((p) => [p.id, nonNegativeInt(p.cap) ? p.cap : 0] as const));
  const base = new Map(spreadByWeight(sorted.map((p) => ({ id: p.id, weight: p.weight })), total).map((p) => [p.id, p.cents]));
  const out = sorted.map((p) => ({ id: p.id, cents: Math.min(base.get(p.id) ?? 0, capOf.get(p.id) ?? 0) }));
  let residue = total - out.reduce((sum, p) => sum + p.cents, 0);
  for (const part of out) {
    if (residue <= 0) break;
    const room = (capOf.get(part.id) ?? 0) - part.cents;
    if (room <= 0) continue;
    const take = Math.min(room, residue);
    part.cents += take;
    residue -= take;
  }
  return out;
}

export type CartComponent = {
  id: string;
  kind: string;
  liabilityClass: "income" | "deposit";
  principalCents: number;
  /** What the owner's side can distribute: principal less any processing fee the owner bears. */
  distributableCents: number;
  residentEmail: string;
};

export type SplitComponent = CartComponent & {
  feeApplies: boolean;
  feeCents: number;
  leasingCents: number;
  ownerCents: number;
  depositCents: number;
  ownerBornCents: number;
};

/** Split a cart's components into owner / fee / deposit. Deterministic and exact. */
export function splitManagedCart(
  terms: ManagedFeeTerms,
  components: readonly CartComponent[],
  cart: CartFee,
  leasingEligibleIds: ReadonlySet<string>,
): SplitComponent[] {
  const applicable = components.filter((c) => c.liabilityClass === "income" && feeAppliesToKind(terms, c.kind));
  const monthly = new Map(spreadByWeight(applicable.map((c) => ({ id: c.id, weight: c.distributableCents })), cart.monthlyFeeCents).map((p) => [p.id, p.cents]));
  const leasingParts = applicable.filter((c) => leasingEligibleIds.has(c.id));
  if (cart.leasingFeeCents > 0 && leasingParts.length === 0) throw new Error("A leasing fee has no first-payment charge.");
  // `credit_managed_capture` caps EACH row's leasing fee at `floor(row.distributable * bps / 10000)`, and a floor of
  // the aggregate can exceed the sum of those floors, so the spread respects the per-row cap the database enforces.
  const leasing = new Map(
    spreadByWeightCapped(
      leasingParts.map((c) => ({
        id: c.id,
        weight: c.distributableCents,
        cap: floorDiv(c.distributableCents * terms.leasingFeeBps, 10_000),
      })),
      cart.leasingFeeCents,
    ).map((p) => [p.id, p.cents]),
  );
  return [...components].sort((a, b) => a.id.localeCompare(b.id)).map((c) => {
    const feeApplies = c.liabilityClass === "income" && feeAppliesToKind(terms, c.kind);
    const fee = feeApplies ? (monthly.get(c.id) ?? 0) : 0;
    const lease = feeApplies ? (leasing.get(c.id) ?? 0) : 0;
    const isDeposit = c.liabilityClass === "deposit";
    const owner = isDeposit ? 0 : c.distributableCents - fee - lease;
    if (owner < 0) throw new Error("A fee cannot exceed the amount distributed.");
    return {
      ...c, feeApplies, feeCents: fee, leasingCents: lease, ownerCents: owner,
      depositCents: isDeposit ? c.distributableCents : 0, ownerBornCents: c.principalCents - c.distributableCents,
    };
  });
}

/**
 * The reversal of a refund of `amount` principal on a payment, pro rata over what is still outstanding. A refund of
 * everything that remains reverses everything that remains exactly. Mirrors `apply_managed_refund` in SQL.
 */
export function refundSplit(input: {
  amountCents: number;
  remainingPrincipalCents: number;
  remainingFeeCents: number;
  remainingOwnerCents: number;
  remainingBorneCents: number;
}): { feeCents: number; borneCents: number; ownerCents: number } {
  const { amountCents: r, remainingPrincipalCents: rp } = input;
  if (![r, rp, input.remainingFeeCents, input.remainingOwnerCents, input.remainingBorneCents].every(nonNegativeInt) || r <= 0 || r > rp) {
    throw new Error("A refund cannot exceed what remains of the payment.");
  }
  if (r === rp) return { feeCents: input.remainingFeeCents, borneCents: input.remainingBorneCents, ownerCents: input.remainingOwnerCents };
  const fee = roundHalfUpDiv(input.remainingFeeCents * r, rp);
  const borne = roundHalfUpDiv(input.remainingBorneCents * r, rp);
  const owner = r - fee - borne;
  if (owner < 0 || owner > input.remainingOwnerCents) throw new Error("Refund split is out of range.");
  return { feeCents: fee, borneCents: borne, ownerCents: owner };
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

/** First instant (UTC ISO) of a Pacific month. */
export function pacificMonthStartIso(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new Error("Invalid month.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  // Probe both Pacific offsets (PST -8, PDT -7); the right one formats back to day 1 hour 0 in Pacific.
  for (const offset of [8, 7]) {
    const candidate = new Date(Date.UTC(year, month - 1, 1, offset, 0, 0));
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", day: "numeric", hour: "numeric", hour12: false, month: "2-digit", year: "numeric" }).formatToParts(candidate);
    const day = fmt.find((p) => p.type === "day")?.value;
    const hour = Number(fmt.find((p) => p.type === "hour")?.value) % 24;
    if (day === "1" && hour === 0) return candidate.toISOString();
  }
  throw new Error("Could not resolve the Pacific month start.");
}

export function nextMonthKey(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new Error("Invalid month.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Canonical text of the terms an owner accepts, and its hash. A fee term change changes the hash. */
export function canonicalPolicyTerms(input: { workspaceId: string; ownerUserId: string; terms: ManagedFeeTerms; effectiveFrom: string }): string {
  const t = input.terms;
  return JSON.stringify({
    v: 2,
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    ownerShareBps: t.ownerShareBps,
    appliesTo: t.appliesTo,
    leasingFeeBps: t.leasingFeeBps,
    minFeeCents: t.minFeeCents,
    effectiveFrom: input.effectiveFrom,
  });
}

export function policyTermsSha256(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Plain-English fee line used in texts and the owner portal. No subtext, no emoji. */
export function describeManagedFee(terms: ManagedFeeTerms): string {
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
  const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  const core = `You receive ${pct(terms.ownerShareBps)}, PropLane keeps ${pct(feeBpsOf(terms))} of ${terms.appliesTo === "rent" ? "rent" : "everything collected"}`;
  const extras = [
    terms.leasingFeeBps > 0 ? `${pct(terms.leasingFeeBps)} leasing fee on a first month` : "",
    terms.minFeeCents > 0 ? `${money(terms.minFeeCents)} monthly minimum` : "",
  ].filter(Boolean);
  return extras.length ? `${core}, plus ${extras.join(", ")}` : core;
}
