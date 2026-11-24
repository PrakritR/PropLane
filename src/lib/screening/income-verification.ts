/**
 * Plaid-verified income, the pure half (no I/O). The figure is computed on the server from the applicant's own
 * linked bank (`lib/plaid/income.server.ts`) and stamped onto the application by the signed-in write; the browser
 * never supplies it. See docs/agents/plaid.md § Income check.
 */
import { INCOME_SHORT_HISTORY_SLACK_DAYS, INCOME_WINDOW_DAYS } from "@/lib/plaid/income-calc";
import { formatPacificDate } from "@/lib/pacific-time";

export type IncomeVerification = {
  source: "plaid";
  /** The payroll deposits of the last `INCOME_WINDOW_DAYS`, divided by `months`. An average, never a pay rate. */
  monthlyIncomeCents: number;
  months: number;
  depositCount: number;
  /** Days of bank history the provider returned. Absent on a row stored before it was recorded. */
  historyDays?: number | null;
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

/**
 * The manager's glyph fact, with the basis of the figure in it:
 * `✓ $4,850/mo avg of payroll deposits, last 90 days (6 deposits) · as of Nov 3`, and
 * `· only 45 days of bank history` when the provider returned materially less than the window — so a figure
 * drawn from a new account reads as one instead of looking like a full quarter of pay. The as-of date is
 * there because a stored figure is reused for up to `INCOME_VERIFICATION_MAX_AGE_DAYS`: without it, a check
 * run a month ago reads as the last 90 days ending today. Never a pill.
 *
 * Every clause is omitted when its fact is missing rather than rendered empty: a row stored before a basis
 * field existed, or a projection that dropped one, must never put the word "undefined" on an applicant's
 * screen. The surfaces that render this line (review row, fact cards, HTML, PDF, the applicant's own view)
 * all come through here, so that holds for all of them at once.
 */
export function incomeVerifiedLine(verification: IncomeVerification, options: { glyph?: boolean } = {}): string {
  const count = verification.depositCount;
  const deposits =
    typeof count === "number" && Number.isFinite(count) && count > 0 ? ` (${count} deposit${count === 1 ? "" : "s"})` : "";
  const history = verification.historyDays;
  const short =
    typeof history === "number" && history > 0 && history < INCOME_WINDOW_DAYS - INCOME_SHORT_HISTORY_SLACK_DAYS
      ? ` · only ${history} days of bank history`
      : "";
  const verifiedAt = Date.parse(verification.verifiedAt ?? "");
  const asOf = Number.isFinite(verifiedAt)
    ? ` · as of ${formatPacificDate(verifiedAt, { month: "short", day: "numeric" })}`
    : "";
  const fact = `${formatIncomeDollars(verification.monthlyIncomeCents)}/mo avg of payroll deposits, last ${INCOME_WINDOW_DAYS} days${deposits}${short}${asOf}`;
  return options.glyph === false ? fact : `✓ ${fact}`;
}

/**
 * What a route sends the applicant's own "Verify income" line: the figure AND every basis clause the line draws.
 * One shape for both the verify POST and the read-back GET, so neither can answer with less than the line needs.
 */
export function incomeVerifiedPayload(verification: IncomeVerification): {
  monthlyIncomeCents: number;
  months: number;
  depositCount: number;
  historyDays: number | null;
  verifiedAt: string;
} {
  return {
    monthlyIncomeCents: verification.monthlyIncomeCents,
    months: verification.months,
    depositCount: verification.depositCount,
    historyDays: verification.historyDays ?? null,
    verifiedAt: verification.verifiedAt,
  };
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
 * The value of an "Income" fact: `$4,800/mo stated · ✓ $4,850/mo avg of payroll deposits, last 90 days (6
 * deposits) · as of Nov 3`, or only the verified half
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
