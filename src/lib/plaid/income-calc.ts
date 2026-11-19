/**
 * Monthly income from bank transactions, the pure half (no I/O, no Plaid client). Plaid's sign convention:
 * `amount` is POSITIVE for money leaving the account and NEGATIVE for money arriving.
 *
 * What counts as income is deliberately conservative, because the figure is shown to a manager next to what the
 * applicant said: only a deposit that looks like payroll (Plaid's INCOME_WAGES category, or a payroll-style name),
 * never a transfer, refund, peer-to-peer payment or a pending line. Fewer than two such deposits is "no figure",
 * never a guess.
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
export const INCOME_MIN_DEPOSITS = 2;
/**
 * The payroll deposits must span at least this many days of real observation. Two deposits a few days
 * apart say nothing about a pay cycle, and dividing by the period they imply would multiply the figure.
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

function dayNumber(value: string | null | undefined): number | null {
  const text = (value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const at = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(at) ? at / 86_400_000 : null;
}

/**
 * The period the payroll deposits themselves cover, in months, as a fraction — never rounded, because
 * rounding the divisor down inflates the figure, and this figure is shown to a manager as verified fact.
 *
 * `n` deposits spanning `span` days imply a pay cycle of `span / (n - 1)`, and together they cover one
 * cycle's worth of earnings beyond the last one, so the period is `span + cycle`. That is accurate for
 * every cadence (two monthly paychecks 30 days apart cover ~1.97 months, not 1; three biweekly ones over
 * 28 days cover ~1.38) and it is capped at the window actually requested, so a wide gap between two
 * deposits can only understate.
 *
 * `{ tooShort: true }` when the deposits span less than `INCOME_MIN_COVERAGE_DAYS` of real observation.
 * `null` when the deposits are not all dated, in which case the caller keeps the requested window.
 */
export function depositCoverageMonths(
  deposits: readonly IncomeTransactionInput[],
  requestedMonths: number,
): { months: number } | { tooShort: true } | null {
  const days = deposits.map((t) => dayNumber(t.date)).filter((d): d is number => d !== null);
  if (days.length < 2 || days.length !== deposits.length) return null;
  const sorted = [...days].sort((a, b) => a - b);
  const spanDays = sorted[sorted.length - 1]! - sorted[0]!;
  if (spanDays < INCOME_MIN_COVERAGE_DAYS) return { tooShort: true };
  const cycleDays = spanDays / (sorted.length - 1);
  const coveredDays = Math.min(spanDays + cycleDays, requestedMonths * DAYS_PER_MONTH);
  return { months: coveredDays / DAYS_PER_MONTH };
}

/**
 * Average monthly payroll-style deposits, or null when there is not enough to say.
 *
 * The divisor is the period the deposits actually cover (`depositCoverageMonths`), never the window we
 * asked for: dividing five weeks of paychecks by three months would understate real income two- to
 * threefold, and dividing them by a rounded one month would overstate it twofold. Deposits spanning
 * less than `INCOME_MIN_COVERAGE_DAYS` yield no figure at all. `months` is the whole-month label for
 * that period; the figure itself is computed from the unrounded divisor.
 */
export function estimateMonthlyIncome(
  transactions: readonly IncomeTransactionInput[],
  months: number = INCOME_LOOKBACK_MONTHS,
): IncomeEstimate | null {
  const deposits = transactions.filter(looksLikePayrollDeposit);
  if (deposits.length < INCOME_MIN_DEPOSITS || months <= 0) return null;
  const coverage = depositCoverageMonths(deposits, months);
  if (coverage && "tooShort" in coverage) return null;
  const divisor = coverage?.months ?? months;
  if (!(divisor > 0)) return null;
  const totalCents = deposits.reduce((sum, txn) => sum + Math.round(Math.abs(txn.amount) * 100), 0);
  const monthlyIncomeCents = Math.round(totalCents / divisor);
  if (monthlyIncomeCents <= 0) return null;
  return { monthlyIncomeCents, months: Math.max(1, Math.round(divisor)), depositCount: deposits.length };
}
