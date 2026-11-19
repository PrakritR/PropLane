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
/** Below this much shared history there is no honest monthly figure to report, so none is reported. */
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
 * How many whole months of history the bank actually shared, from the span of the transactions it
 * returned — never more than `requestedMonths`, and never less than one. `null` when no transaction
 * carries a date (the denominator then stays the requested window) or when the span is shorter than
 * `INCOME_MIN_COVERAGE_DAYS`, which is "too little history to say" rather than a bigger figure.
 */
export function coveredMonths(
  transactions: readonly IncomeTransactionInput[],
  requestedMonths: number,
): { months: number } | { tooShort: true } | null {
  const days = transactions.map((t) => dayNumber(t.date)).filter((d): d is number => d !== null);
  if (days.length === 0) return null;
  const spanDays = Math.max(...days) - Math.min(...days) + 1;
  if (spanDays < INCOME_MIN_COVERAGE_DAYS) return { tooShort: true };
  return { months: Math.max(1, Math.min(requestedMonths, Math.round(spanDays / DAYS_PER_MONTH))) };
}

/**
 * Average monthly payroll-style deposits, or null when there is not enough to say.
 *
 * The divisor is the history the bank actually shared, not the window we asked for: an institution
 * that returns five weeks would otherwise have two paychecks divided by three months and understate
 * real income two- to threefold — and the figure is shown to a manager as verified fact. Shorter than
 * `INCOME_MIN_COVERAGE_DAYS` of history yields no figure at all, so a short window can never inflate
 * one either. The `months` returned is the divisor used, which is also what the manager is shown.
 */
export function estimateMonthlyIncome(
  transactions: readonly IncomeTransactionInput[],
  months: number = INCOME_LOOKBACK_MONTHS,
): IncomeEstimate | null {
  const deposits = transactions.filter(looksLikePayrollDeposit);
  if (deposits.length < INCOME_MIN_DEPOSITS || months <= 0) return null;
  const coverage = coveredMonths(transactions, months);
  if (coverage && "tooShort" in coverage) return null;
  const divisor = coverage?.months ?? months;
  const totalCents = deposits.reduce((sum, txn) => sum + Math.round(Math.abs(txn.amount) * 100), 0);
  const monthlyIncomeCents = Math.round(totalCents / divisor);
  if (monthlyIncomeCents <= 0) return null;
  return { monthlyIncomeCents, months: divisor, depositCount: deposits.length };
}
