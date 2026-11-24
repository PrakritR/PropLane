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
/** How far from the median amount a deposit may sit and still be read as pay rather than as something extra. */
const OFF_CYCLE_AMOUNT_SHARE = 0.25;

type DepositDay = { txn: IncomeTransactionInput; day: number; cents: number };

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

/** The middle value, not the average one: one odd gap or amount moves it by a place in the order, never by its size. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Which deposits are the PAY, and the period they earn over. Three numbers, and only one of them is a fact.
 *
 * Pay sits on the cadence in BOTH amount and time, so an off-cycle deposit — a bonus, a correction run, a
 * final check — is set aside by whichever of the two it fails, wherever it sits in the history:
 *
 *   1. its amount is more than a quarter away from the MEDIAN amount (a $5,000 bonus among $2,425 paychecks);
 *   2. it lands less than half a median cadence after the deposit before it, and of that pair the one further
 *      from the median amount is the extra (a $3,000 bonus the day before, or the day after, a paycheck).
 *
 * Neither test may privilege a position: a $8,000 bonus dated the day BEFORE the first paycheck used to
 * become the anchor the rest were measured against and swallow that paycheck, reading $7,588/mo on $5,272 of
 * real pay — the mirror of the $3,000-bonus case ($8,089/mo on the same pay) a mean cadence produced. Counted
 * as pay, an extra deposit moves the figure twice: it adds to it AND shrinks the period it is spread over.
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
 * `{ tooShort: true }` when fewer than `INCOME_MIN_DEPOSITS` deposits are left on the cadence, or they span
 * less than `INCOME_MIN_COVERAGE_DAYS` of real observation. `null` when the deposits are not all dated, in
 * which case the caller keeps the requested window.
 */
export function depositCoverageMonths(
  deposits: readonly IncomeTransactionInput[],
): { months: number; observedMonths: number; regular: readonly IncomeTransactionInput[] } | { tooShort: true } | null {
  const dated = deposits
    .map((txn) => ({ txn, day: dayNumber(txn.date), cents: Math.round(Math.abs(txn.amount) * 100) }))
    .filter((entry): entry is DepositDay => entry.day !== null);
  if (dated.length < INCOME_MIN_DEPOSITS || dated.length !== deposits.length) return null;
  const sorted = [...dated].sort((a, b) => a.day - b.day);
  const gapsOf = (entries: readonly DepositDay[]) => entries.slice(1).map((entry, i) => entry.day - entries[i]!.day);
  const typicalCents = median(sorted.map((entry) => entry.cents));
  const offTypical = (entry: DepositDay) => Math.abs(entry.cents - typicalCents);
  const sized = sorted.filter((entry) => offTypical(entry) <= typicalCents * OFF_CYCLE_AMOUNT_SHARE);
  if (sized.length < INCOME_MIN_DEPOSITS) return { tooShort: true };
  const offCycleUnder = median(gapsOf(sized)) / 2;
  const regular: DepositDay[] = [];
  for (const entry of sized) {
    const previous = regular[regular.length - 1];
    if (!previous || entry.day - previous.day >= offCycleUnder) regular.push(entry);
    else if (offTypical(entry) < offTypical(previous)) regular[regular.length - 1] = entry;
  }
  if (regular.length < INCOME_MIN_DEPOSITS) return { tooShort: true };
  const spanDays = regular[regular.length - 1]!.day - regular[0]!.day;
  if (spanDays < INCOME_MIN_COVERAGE_DAYS) return { tooShort: true };
  const cycleDays = median(gapsOf(regular));
  return {
    months: (spanDays + cycleDays) / DAYS_PER_MONTH,
    observedMonths: (sorted[sorted.length - 1]!.day - sorted[0]!.day) / DAYS_PER_MONTH,
    regular: regular.map((entry) => entry.txn),
  };
}

/**
 * Average monthly payroll-style deposits, or the reason there is no figure.
 *
 * Both halves come from `depositCoverageMonths`: the deposits that sit on the cadence in amount and in time
 * are the figure, and the period THEY earn over is the divisor, never the window we asked for (dividing five
 * weeks of weekly paychecks by three months reports a third of a real income; dividing three paychecks 45
 * days apart by those same three months reports half again more than arrives). An off-cycle deposit is in
 * neither half - a bonus is money that arrived, not a monthly rate. Fewer than `INCOME_MIN_DEPOSITS` left on
 * the cadence, or a span under `INCOME_MIN_COVERAGE_DAYS`, yields no figure at all. `months` is the whole-month label for the
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
