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
 * Three, not two, and three deposits ON ONE PAYER'S CADENCE: the divisor is the pay cycle read off the gaps
 * between them, and two deposits give exactly one gap — a guess that cannot tell a monthly paycheck pair from
 * a paycheck plus a bonus or a severance (`looksLikePayrollDeposit` admits both). An off-cycle deposit is set
 * aside before the count is taken, so a pair plus a bonus is still a pair, and is still "no figure" — which
 * costs an applicant nothing: the check never blocks a submit.
 */
export const INCOME_MIN_DEPOSITS = 3;
/**
 * A payer's deposits must span at least this many days of real observation. Deposits a few days apart say
 * nothing about a pay cycle, and dividing by the period they imply would multiply the figure.
 */
export const INCOME_MIN_COVERAGE_DAYS = 28;
const DAYS_PER_MONTH = 30.44;
/** How far from its stream's median amount a deposit may sit and still be read as pay rather than something extra. */
const OFF_CYCLE_AMOUNT_SHARE = 0.25;

type DepositDay = { payer: string; day: number; cents: number };

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
 * WHO paid, as a key: Plaid's counterparty when it names one, else the description without the reference
 * numbers that differ run to run ("GUSTO DIRECT DEP 4412" and "GUSTO DIRECT DEP 4581" are one payer).
 */
function payerKey(txn: IncomeTransactionInput): string {
  const label = (txn.merchant_name ?? "").trim() || (txn.name ?? "").trim();
  return label
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const gapsOf = (entries: readonly DepositDay[]) => entries.slice(1).map((entry, i) => entry.day - entries[i]!.day);

/**
 * One payer's pay: the deposits that sit on ITS cadence, and the period they earn over. `null` when this payer
 * is not a pay stream — fewer than `INCOME_MIN_DEPOSITS` on a cadence, or a span under
 * `INCOME_MIN_COVERAGE_DAYS` of real observation.
 *
 * A stream is the unit because an applicant can hold two jobs, and ONE amount band across both drops the
 * larger of them: a $5,000 salary beside a more numerous $500 weekly side payroll read as $2,174/mo on
 * $7,167 of real pay. Each payer is read on its own and the rates are added, so neither one hides the other.
 *
 * Within the stream, pay sits on the cadence in BOTH amount and time, so an off-cycle deposit — a bonus, a
 * correction run, a final check — is set aside by whichever of the two it fails, wherever it sits:
 *
 *   1. its amount is more than a quarter away from the stream's MEDIAN amount (a $5,000 bonus among $2,425
 *      paychecks), or
 *   2. it lands less than half a median cadence after the deposit before it, and of that pair the one
 *      further from the median amount is the extra (a $3,000 bonus the day before, or after, a paycheck).
 *
 * Neither test may privilege a position: a bonus dated the day BEFORE the first paycheck once became the
 * anchor the rest were measured against, reading $7,588/mo on $5,272 of real pay. Counted as pay, an extra
 * deposit moves the figure twice: it adds to it AND shrinks the period it is spread over.
 *
 * The period is `span + cycle`: deposits spanning `span` days on a cycle of `cycle` are together a cycle's
 * worth of earnings beyond the last one. It is the observed period alone — the window asked for never widens
 * or narrows it (five weekly paychecks over 28 days earn over 35 days, not over the three months the bank was
 * asked for; three paychecks 45 days apart earn over 135) — and it is never rounded, which would inflate it.
 */
function streamPayRate(stream: readonly DepositDay[]): { months: number; cents: number; regular: DepositDay[] } | null {
  if (stream.length < INCOME_MIN_DEPOSITS) return null;
  const sorted = [...stream].sort((a, b) => a.day - b.day);
  const typicalCents = median(sorted.map((entry) => entry.cents));
  const offTypical = (entry: DepositDay) => Math.abs(entry.cents - typicalCents);
  const sized = sorted.filter((entry) => offTypical(entry) <= typicalCents * OFF_CYCLE_AMOUNT_SHARE);
  if (sized.length < INCOME_MIN_DEPOSITS) return null;
  const offCycleUnder = median(gapsOf(sized)) / 2;
  const regular: DepositDay[] = [];
  for (const entry of sized) {
    const previous = regular[regular.length - 1];
    if (!previous || entry.day - previous.day >= offCycleUnder) regular.push(entry);
    else if (offTypical(entry) < offTypical(previous)) regular[regular.length - 1] = entry;
  }
  if (regular.length < INCOME_MIN_DEPOSITS) return null;
  const spanDays = regular[regular.length - 1]!.day - regular[0]!.day;
  if (spanDays < INCOME_MIN_COVERAGE_DAYS) return null;
  const cycleDays = median(gapsOf(regular));
  return {
    months: (spanDays + cycleDays) / DAYS_PER_MONTH,
    cents: regular.reduce((sum, entry) => sum + entry.cents, 0),
    regular,
  };
}

/**
 * Average monthly payroll-style deposits, or the reason there is no figure.
 *
 * The figure is the sum of each PAYER's own rate (`streamPayRate`), so two jobs add up and neither hides the
 * other; a payer that is not a pay stream, and an off-cycle deposit inside one, are in neither the sum nor
 * the count - a bonus is money that arrived, not a monthly rate. No pay stream at all yields no figure.
 * `months` is the whole-month label for the history the bank shared, a fact the manager can hold the figure
 * against; it is deliberately not a divisor, which is per stream, derived and used unrounded.
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
  const dated = deposits
    .map((txn) => ({ payer: payerKey(txn), day: dayNumber(txn.date), cents: Math.round(Math.abs(txn.amount) * 100) }))
    .filter((entry): entry is DepositDay => entry.day !== null);
  if (dated.length !== deposits.length) {
    const totalCents = deposits.reduce((sum, txn) => sum + Math.round(Math.abs(txn.amount) * 100), 0);
    const windowed = Math.round(totalCents / months);
    if (windowed <= 0) return { ok: false, reason: "no_payroll_deposits", depositCount };
    return { ok: true, estimate: { monthlyIncomeCents: windowed, months, depositCount } };
  }
  const streams = new Map<string, DepositDay[]>();
  for (const entry of dated) streams.set(entry.payer, [...(streams.get(entry.payer) ?? []), entry]);
  const rates = [...streams.values()].map(streamPayRate).filter((rate): rate is NonNullable<typeof rate> => rate !== null);
  if (rates.length === 0) return { ok: false, reason: "not_enough_history", depositCount };
  const monthlyIncomeCents = Math.round(rates.reduce((sum, rate) => sum + rate.cents / rate.months, 0));
  if (monthlyIncomeCents <= 0) return { ok: false, reason: "no_payroll_deposits", depositCount };
  const days = dated.map((entry) => entry.day);
  const observedMonths = (Math.max(...days) - Math.min(...days)) / DAYS_PER_MONTH;
  return {
    ok: true,
    estimate: {
      monthlyIncomeCents,
      months: Math.max(1, Math.round(observedMonths)),
      depositCount: rates.reduce((count, rate) => count + rate.regular.length, 0),
    },
  };
}
