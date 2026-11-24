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
 * Three, not two, and three deposits ON THE CADENCE: the divisor is the pay cycle read off the gaps between
 * them, and two deposits give exactly one gap — a guess that cannot tell a monthly paycheck pair from a
 * paycheck plus a bonus or a severance (`looksLikePayrollDeposit` admits both). An off-cycle deposit is set
 * aside before the count is taken, so a pair plus a bonus is still a pair, and is still "no figure" — which
 * costs an applicant nothing: the check never blocks a submit.
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

/** The middle gap, not the average one: one odd gap moves it by a place in the order, never by its size. */
function medianDays(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Which deposits are the PAY, and the period they earn over. Three numbers, and only one of them is a fact.
 *
 * The cadence is the MEDIAN gap between the dated deposits, and a deposit arriving less than half a cadence
 * after the last one that sat on it is off-cycle — a bonus, a correction run, a final check. Off-cycle
 * deposits are set aside: counted as pay they would both add to the figure and shrink the period it is
 * spread over, which is how a $3,000 bonus the day after a biweekly paycheck read as $8,089/mo on $5,254 of
 * real pay. A mean gap cannot do this: the one-day gap drags it down and the bonus is read as a pay cycle.
 *
 * `months` is the period the REGULAR deposits earn over, the divisor, and it is the observed period alone —
 * the window asked for never widens or narrows it: deposits spanning `span` days on a cycle of `cycle` are
 * together a cycle's worth of earnings beyond the last one, so the period is `span + cycle`. That is
 * unbiased for regular pay in either direction — five weekly paychecks over 28 days earn over 35 days, not
 * over the three months the bank was asked for, and three paychecks 45 days apart earn over 135 days, not
 * over those same three months. It is never rounded: rounding it down inflates the figure.
 *
 * `observedMonths` is the history the bank actually shared, the span of EVERY payroll deposit. That is what
 * the manager is shown, so the label names observed history and never an inferred period.
 *
 * `{ tooShort: true }` when fewer than `INCOME_MIN_DEPOSITS` deposits sit on the cadence, or they span less
 * than `INCOME_MIN_COVERAGE_DAYS` of real observation. `null` when the deposits are not all dated, in which
 * case the caller keeps the requested window.
 */
export function depositCoverageMonths(
  deposits: readonly IncomeTransactionInput[],
): { months: number; observedMonths: number; regular: readonly IncomeTransactionInput[] } | { tooShort: true } | null {
  const dated = deposits
    .map((txn) => ({ txn, day: dayNumber(txn.date) }))
    .filter((entry): entry is { txn: IncomeTransactionInput; day: number } => entry.day !== null);
  if (dated.length < INCOME_MIN_DEPOSITS || dated.length !== deposits.length) return null;
  const sorted = [...dated].sort((a, b) => a.day - b.day);
  const gapsOf = (entries: readonly { day: number }[]) => entries.slice(1).map((entry, i) => entry.day - entries[i]!.day);
  const offCycleUnder = medianDays(gapsOf(sorted)) / 2;
  const regular = [sorted[0]!];
  for (const entry of sorted.slice(1)) {
    if (entry.day - regular[regular.length - 1]!.day >= offCycleUnder) regular.push(entry);
  }
  if (regular.length < INCOME_MIN_DEPOSITS) return { tooShort: true };
  const spanDays = regular[regular.length - 1]!.day - regular[0]!.day;
  if (spanDays < INCOME_MIN_COVERAGE_DAYS) return { tooShort: true };
  const cycleDays = medianDays(gapsOf(regular));
  return {
    months: (spanDays + cycleDays) / DAYS_PER_MONTH,
    observedMonths: (sorted[sorted.length - 1]!.day - sorted[0]!.day) / DAYS_PER_MONTH,
    regular: regular.map((entry) => entry.txn),
  };
}

/**
 * Average monthly payroll-style deposits, or the reason there is no figure.
 *
 * Both halves come from `depositCoverageMonths`: the deposits that sit on the cadence are the figure, and the
 * period THEY earn over is the divisor, never the window we asked for (dividing five weeks of weekly
 * paychecks by three months reports a third of a real income; dividing three paychecks 45 days apart by
 * those same three months reports half again more than arrives). An off-cycle deposit is in neither half -
 * a bonus is money that arrived, not a monthly rate. Fewer than `INCOME_MIN_DEPOSITS` on the cadence, or a
 * span under `INCOME_MIN_COVERAGE_DAYS`, yields no figure at all. `months` is the whole-month label for the
 * history the bank shared, a fact the manager can hold the figure against; it is deliberately not the
 * divisor, which is a derived period used unrounded.
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
  const counted = coverage ? coverage.regular : deposits;
  const totalCents = counted.reduce((sum, txn) => sum + Math.round(Math.abs(txn.amount) * 100), 0);
  const monthlyIncomeCents = Math.round(totalCents / divisor);
  if (monthlyIncomeCents <= 0) return { ok: false, reason: "no_payroll_deposits", depositCount };
  const observed = coverage ? Math.max(1, Math.round(coverage.observedMonths)) : months;
  return { ok: true, estimate: { monthlyIncomeCents, months: observed, depositCount: counted.length } };
}
