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

/**
 * The value of an "Income" fact: `$4,800/mo stated · ✓ $4,850/mo verified (Plaid, 3 mo)`, or only the verified half
 * when nothing was stated.
 * `stated` is the applicant's own answer (free text such as "4,800" or "$4800").
 */
export function incomeStatedVsVerifiedLine(
  stated: string | null | undefined,
  verification: IncomeVerification,
  /** `glyph: false` for the PDF, whose standard font cannot draw the check mark. */
  options: { glyph?: boolean } = {},
): string {
  const digits = (stated ?? "").replace(/[^0-9.]/g, "");
  const n = digits ? Number.parseFloat(digits) : NaN;
  const verified = incomeVerifiedLine(verification, options);
  if (!Number.isFinite(n) || n <= 0) return verified;
  return `${formatIncomeDollars(Math.round(n * 100))}/mo stated · ${verified}`;
}
