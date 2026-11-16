/**
 * Duplicate-payment protection (pure). Before an expense is marked Paid or a payment is recorded, the
 * candidate is compared against the workspace's paid history. Two payments are the same payment when they
 * went to the same payee, for the same amount, on the same house (or either has no house), and EITHER
 * cover the same billing period OR were paid within DUPLICATE_PAID_WINDOW_DAYS of each other.
 *
 * The real case this exists for: October 2026 Seattle Public Utilities bills for 5257 ($525.63) and
 * 4709A ($638.05) were each paid twice (Oct 29 and Nov 6). Eight days apart is outside the date window,
 * so the billing period is what catches it.
 *
 * The server (`findDuplicateExpenses`, `expense-duplicates.server.ts`) loads the history; this file only
 * decides, so the same rule is testable without a database.
 */

export const DUPLICATE_PAID_WINDOW_DAYS = 3;

export type PaymentFingerprint = {
  id?: string | null;
  amountCents: number;
  propertyId?: string | null;
  payeeId?: string | null;
  vendorId?: string | null;
  /** Free-text payee ("Seattle Public Utilities"). Normalized before comparing. */
  payeeLabel?: string | null;
  /** The row's memo; for older entries with no payee this is the only name the row carries. */
  memo?: string | null;
  /** The date the money left (paid date, falling back to the entry date). */
  paidDate: string;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
};

export type DuplicateMatch = {
  id: string;
  amountCents: number;
  paidDate: string;
  billingPeriod: string | null;
  memo: string | null;
  reason: "same_billing_period" | "paid_within_window";
};

export function normalizePayeeName(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** `YYYY-MM` of the period a bill covers (its start, else its end), or null when the entry names none. */
export function billingPeriodKey(start?: string | null, end?: string | null): string | null {
  const day = (start && /^\d{4}-\d{2}/.test(start) ? start : end && /^\d{4}-\d{2}/.test(end) ? end : null);
  return day ? day.slice(0, 7) : null;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

function samePayee(a: PaymentFingerprint, b: PaymentFingerprint): boolean {
  if (a.payeeId && b.payeeId) return a.payeeId === b.payeeId;
  if (a.vendorId && b.vendorId) return a.vendorId === b.vendorId;
  const an = normalizePayeeName(a.payeeLabel);
  const bn = normalizePayeeName(b.payeeLabel);
  if (an && bn) return an === bn;
  // An older entry has no payee, only a memo: the candidate's payee name appearing in it counts.
  const candidateName = an || normalizePayeeName(a.memo);
  const historyMemo = normalizePayeeName(b.memo);
  if (an && historyMemo.length >= 4 && historyMemo.includes(an)) return true;
  if (bn && candidateName.length >= 4 && candidateName.includes(bn)) return true;
  return false;
}

/** Every history payment the candidate duplicates, nearest in time first. */
export function findDuplicatePayments(
  candidate: PaymentFingerprint,
  history: readonly PaymentFingerprint[],
): DuplicateMatch[] {
  const candidatePeriod = billingPeriodKey(candidate.billingPeriodStart, candidate.billingPeriodEnd);
  const matches: DuplicateMatch[] = [];
  for (const row of history) {
    if (!row.id || (candidate.id && row.id === candidate.id)) continue;
    if (row.amountCents !== candidate.amountCents) continue;
    if (candidate.propertyId && row.propertyId && candidate.propertyId !== row.propertyId) continue;
    if (!samePayee(candidate, row)) continue;
    const rowPeriod = billingPeriodKey(row.billingPeriodStart, row.billingPeriodEnd);
    const samePeriod = candidatePeriod !== null && rowPeriod !== null && candidatePeriod === rowPeriod;
    const withinWindow =
      Math.abs(dayNumber(candidate.paidDate) - dayNumber(row.paidDate)) <= DUPLICATE_PAID_WINDOW_DAYS;
    if (!samePeriod && !withinWindow) continue;
    matches.push({
      id: row.id,
      amountCents: row.amountCents,
      paidDate: row.paidDate,
      billingPeriod: rowPeriod,
      memo: row.memo ?? null,
      reason: samePeriod ? "same_billing_period" : "paid_within_window",
    });
  }
  return matches.sort(
    (x, y) =>
      Math.abs(dayNumber(x.paidDate) - dayNumber(candidate.paidDate)) -
      Math.abs(dayNumber(y.paidDate) - dayNumber(candidate.paidDate)),
  );
}

/** One line the Add form shows above the override: what it matched and why. */
export function describeDuplicate(match: DuplicateMatch): string {
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(match.amountCents / 100);
  const why = match.reason === "same_billing_period" ? `the same billing period${match.billingPeriod ? ` (${match.billingPeriod})` : ""}` : "within 3 days";
  return `${money} already paid on ${match.paidDate} - ${why}`;
}

export const MIN_OVERRIDE_REASON_LENGTH = 5;

export function validOverrideReason(reason: unknown): reason is string {
  return typeof reason === "string" && reason.trim().length >= MIN_OVERRIDE_REASON_LENGTH;
}
