/**
 * Monthly income from bank transactions, the pure half (no I/O, no Plaid client). Plaid's sign convention:
 * `amount` is POSITIVE for money leaving the account and NEGATIVE for money arriving.
 *
 * What counts as income is deliberately conservative, because the figure is shown to a manager next to what the
 * applicant said: only a deposit that looks like payroll (Plaid's INCOME_WAGES category, or a payroll-style name),
 * never a transfer, refund, peer-to-peer payment or a pending line. Fewer than `INCOME_MIN_DEPOSITS` such deposits is
 * "no figure", never a guess.
 */

export type IncomeTransactionInput = {
  amount: number;
  /** Plaid's posted date (`YYYY-MM-DD`). Used only to measure how much history the bank actually shared. */
  date?: string | null;
  name?: string | null;
  merchant_name?: string | null;
  pending?: boolean | null;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
};

export const INCOME_LOOKBACK_MONTHS = 3;
/**
 * Three, not two: the divisor is the pay cycle read off the gaps between deposits, and two deposits give
 * exactly one gap — a guess that cannot tell a monthly paycheck pair from a paycheck plus a bonus or a
 * severance (`looksLikePayrollDeposit` admits both). From three deposits the cadence is measured across
 * at least two gaps. Fewer is "no figure", which costs an applicant nothing: the check never blocks a submit.
 */
export const INCOME_MIN_DEPOSITS = 3;
/**
 * The payroll deposits must span at least this many days of real observation. Deposits a few days apart
 * say nothing about a pay cycle, and dividing by the period they imply would multiply the figure.
 */
export const INCOME_MIN_COVERAGE_DAYS = 28;
const DAYS_PER_MONTH = 30.44;

const PAYROLL_NAME = /\b(payroll|direct\s*dep(?:osit)?|dir\s*dep|salary|paychec?k|wages|gusto|adp|paycom|paylocity|paychex|rippling|trinet|justworks|workday)\b/i;
const NOT_INCOME_NAME = /\b(transfer|xfer|refund|reversal|venmo|zelle|cash\s*app|paypal|apple\s*cash|loan|credit\s*card|autopay|deposit\s*return)\b/i;

export function looksLikePayrollDeposit(txn: IncomeTransactionInput): boolean {
  if (typeof txn.amount !== "number" || !Number.isFinite(txn.amount) || txn.amount >= 0) return false;
  if (txn.pending === true) return false;
  const category = txn.personal_finance_category;
  if (category?.primary === "TRANSFER_IN" || category?.primary === "LOAN_DISBURSEMENTS") return false;
  if (category?.detailed === "INCOME_WAGES") return true;
  const label = `${txn.name ?? ""} ${txn.merchant_name ?? ""}`;
  if (NOT_INCOME_NAME.test(label)) return false;
  return PAYROLL_NAME.test(label);
}

export type IncomeEstimate = { monthlyIncomeCents: number; months: number; depositCount: number };

/** Why there is no figure. `no_payroll_deposits` is "nothing in that account looked like pay";
 * `not_enough_history` is "paychecks are there, but too few or too close together to divide by". The
 * caller must never re-derive this by counting deposits itself: a new refusal branch here would
 * silently fall into the wrong message. */
export type IncomeEstimateRefusal = "no_payroll_deposits" | "not_enough_history";

export type IncomeEstimateOutcome =
  | { ok: true; estimate: IncomeEstimate }
  | { ok: false; reason: IncomeEstimateRefusal; depositCount: number };

function dayNumber(value: string | null | undefined): number | null {
  const text = (value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const at = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(at) ? at / 86_400_000 : null;
}

/**
 * Two separate numbers, because they answer two different questions and only one of them is a fact.
 *
 * `months` is the period the deposits EARN over, the divisor, and it is the observed period alone — the
 * window asked for never widens or narrows it: `n` deposits spanning `span` days are spaced by a cycle of
 * `span / (n - 1)`, and together they are a cycle's worth of earnings beyond the last one, so the period
 * is `span + cycle`. That is unbiased for regular pay in either direction — five weekly paychecks over 28
 * days earn over 35 days, not over the three months the bank was asked for, and three paychecks 45 days
 * apart earn over 135 days, not over those same three months. It is never rounded: rounding it down
 * inflates the figure. `n` is at least `INCOME_MIN_DEPOSITS`, so the cycle is measured across two or more
 * gaps rather than guessed from one, and `INCOME_MIN_COVERAGE_DAYS` keeps a few days apart from a cadence.
 *
 * `observedMonths` is the history the bank actually shared, the span alone. That is what the manager is
 * shown, so the label names observed history and never an inferred period.
 *
 * `{ tooShort: true }` when the deposits span less than `INCOME_MIN_COVERAGE_DAYS` of real observation.
 * `null` when the deposits are not all dated, in which case the caller keeps the requested window.
 */
export function depositCoverageMonths(
  deposits: readonly IncomeTransactionInput[],
): { months: number; observedMonths: number } | { tooShort: true } | null {
  const days = deposits.map((t) => dayNumber(t.date)).filter((d): d is number => d !== null);
  if (days.length < INCOME_MIN_DEPOSITS || days.length !== deposits.length) return null;
  const sorted = [...days].sort((a, b) => a - b);
  const spanDays = sorted[sorted.length - 1]! - sorted[0]!;
  if (spanDays < INCOME_MIN_COVERAGE_DAYS) return { tooShort: true };
  const cycleDays = spanDays / (sorted.length - 1);
  return { months: (spanDays + cycleDays) / DAYS_PER_MONTH, observedMonths: spanDays / DAYS_PER_MONTH };
}

/**
 * Average monthly payroll-style deposits, or the reason there is no figure.
 *
 * The divisor is the period the deposits actually earn over (`depositCoverageMonths`), never the window we
 * asked for: dividing five weeks of weekly paychecks by three months reports a third of a real income, and
 * dividing three paychecks 45 days apart by those same three months reports half again more than arrives.
 * Deposits spanning less than `INCOME_MIN_COVERAGE_DAYS` yield no figure at all. `months` is the whole-month
 * label for the history the bank shared, a fact the manager can hold the figure against; it is deliberately
 * not the divisor, which is a derived period used unrounded.
 *
 * A refusal says WHICH of the two it is, because "we found no paychecks" and "we found paychecks but too
 * little history" are different answers to the applicant and only this function knows which applies.
 */
export function estimateMonthlyIncome(
  transactions: readonly IncomeTransactionInput[],
  months: number = INCOME_LOOKBACK_MONTHS,
): IncomeEstimateOutcome {
  const deposits = transactions.filter(looksLikePayrollDeposit);
  const depositCount = deposits.length;
  if (depositCount === 0) return { ok: false, reason: "no_payroll_deposits", depositCount };
  if (depositCount < INCOME_MIN_DEPOSITS || months <= 0) return { ok: false, reason: "not_enough_history", depositCount };
  const coverage = depositCoverageMonths(deposits);
  if (coverage && "tooShort" in coverage) return { ok: false, reason: "not_enough_history", depositCount };
  const divisor = coverage?.months ?? months;
  if (!(divisor > 0)) return { ok: false, reason: "not_enough_history", depositCount };
  const totalCents = deposits.reduce((sum, txn) => sum + Math.round(Math.abs(txn.amount) * 100), 0);
  const monthlyIncomeCents = Math.round(totalCents / divisor);
  if (monthlyIncomeCents <= 0) return { ok: false, reason: "no_payroll_deposits", depositCount };
  const observed = coverage ? Math.max(1, Math.round(coverage.observedMonths)) : months;
  return { ok: true, estimate: { monthlyIncomeCents, months: observed, depositCount } };
}
