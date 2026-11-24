/**
 * Plaid-verified income, the pure half (no I/O). The figure is computed on the server from the applicant's own
 * linked bank (`lib/plaid/income.server.ts`) and stamped onto the application by the signed-in write; the browser
 * never supplies it. See docs/agents/plaid.md § Income check.
 */

export type IncomeVerification = {
  source: "plaid";
  /** Average monthly payroll-style deposits over `months`, in cents. */
  monthlyIncomeCents: number;
  months: number;
  depositCount: number;
  /** ISO timestamp the figure was computed. */
  verifiedAt: string;
  institutionName?: string | null;
};

/** A verification older than this is stale and is never stamped onto a new application. */
export const INCOME_VERIFICATION_MAX_AGE_DAYS = 30;

export function isIncomeVerification(value: unknown): value is IncomeVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.source === "plaid" &&
    typeof v.monthlyIncomeCents === "number" &&
    Number.isFinite(v.monthlyIncomeCents) &&
    v.monthlyIncomeCents > 0 &&
    typeof v.months === "number" &&
    v.months > 0 &&
    typeof v.verifiedAt === "string"
  );
}

export function isIncomeVerificationFresh(verification: IncomeVerification, now: Date = new Date()): boolean {
  const at = Date.parse(verification.verifiedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= INCOME_VERIFICATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Whole dollars with a thousands separator, e.g. `$4,850`. Cents are rounded away: this is an estimate. */
export function formatIncomeDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** The manager's glyph fact: `✓ $4,850/mo verified (Plaid, 3 mo)`. Never a pill. */
export function incomeVerifiedLine(verification: IncomeVerification, options: { glyph?: boolean } = {}): string {
  const fact = `${formatIncomeDollars(verification.monthlyIncomeCents)}/mo verified (Plaid, ${verification.months} mo)`;
  return options.glyph === false ? fact : `✓ ${fact}`;
}

/** A single plain amount the applicant typed (`4800`, `4,800`, `$4,800.50`), in cents. Null for anything else. */
function statedAmountCents(stated: string): number | null {
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(stated);
  if (!match) return null;
  const dollars = Number.parseInt(match[1]!.replace(/,/g, ""), 10);
  const cents = Number.parseInt((match[2] ?? "0").padEnd(2, "0"), 10);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return dollars * 100 + cents;
}

/**
 * The value of an "Income" fact: `$4,800/mo stated · ✓ $4,850/mo verified (Plaid, 3 mo)`, or only the verified half
 * when nothing was stated.
 *
 * `stated` is the applicant's own free-text answer. Only a single plain amount is read as money; anything else
 * ("4,800 - 5,200", "4.8k", "varies") is quoted back as the applicant wrote it, because concatenating its digits
 * would show the manager a figure nobody stated.
 */
export function incomeStatedVsVerifiedLine(
  stated: string | null | undefined,
  verification: IncomeVerification,
  /** `glyph: false` for the PDF, whose standard font cannot draw the check mark. */
  options: { glyph?: boolean } = {},
): string {
  const raw = (stated ?? "").trim();
  const verified = incomeVerifiedLine(verification, options);
  if (!raw) return verified;
  const cents = statedAmountCents(raw);
  return cents === null
    ? `${raw} stated · ${verified}`
    : `${formatIncomeDollars(cents)}/mo stated · ${verified}`;
}
