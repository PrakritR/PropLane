/**
 * Monthly income from bank transactions, the pure half (no I/O, no Plaid client). Plaid's sign convention:
 * `amount` is POSITIVE for money leaving the account and NEGATIVE for money arriving.
 *
 * The figure is an OBSERVATION, not a predicted pay rate: what payroll actually landed in the window, divided by
 * the window. Deriving a rate instead - a pay cycle off the gaps, amount bands, per-payer streams - put a figure
 * on the manager's screen that was wrong in both directions for ordinary histories (a bonus read as pay, a job
 * change read as two salaries, variable hourly pay read as one amount plus outliers), and every repair needed
 * another heuristic. An average of real deposits over a stated window has no such failure: the manager can hold
 * it against the applicant's own answer, and the basis - how many deposits, over what window, out of how much
 * bank history - is shown with it.
 *
 * What counts as income is still deliberately conservative: only a deposit that looks like payroll (Plaid's
 * INCOME_WAGES category, or a payroll-style name), never a transfer, refund, peer-to-peer payment or a pending
 * line. Fewer than `INCOME_MIN_DEPOSITS` such deposits in the window is "no figure", never a guess.
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

/** The window the bank is asked for, and the one the figure is divided by. Both halves are shown to the manager. */
export const INCOME_LOOKBACK_MONTHS = 3;
export const INCOME_WINDOW_DAYS = 90;
/**
 * Three deposits in the window, or no figure — which costs an applicant nothing: the check never blocks a
 * submit. One or two deposits are a single pay run, not a month of pay, and dividing them by the window would
 * put a number on the screen that says more about when the account was linked than about the applicant.
 */
export const INCOME_MIN_DEPOSITS = 3;

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

export type IncomeEstimate = {
  /** Payroll deposits in the window, divided by the window. An average of what arrived, never a predicted rate. */
  monthlyIncomeCents: number;
  /** The window the sum was divided by, in months. */
  months: number;
  /** How many payroll deposits the average is made of. */
  depositCount: number;
};

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
 * The average monthly payroll that actually landed in the window, or the reason there is no figure.
 *
 * Every payroll-matched deposit dated inside the window counts: a bonus, a variable hourly week and the final
 * checks of a job the applicant just left are all money that arrived, and a window average says so without
 * claiming any of them repeats. The divisor is the window itself, never a period derived from the deposits, so
 * the figure cannot be moved by one odd gap or one odd amount. A deposit with no usable date is ignored rather
 * than guessed at.
 *
 * A refusal says WHICH of the two it is, because "we found no paychecks" and "we found paychecks but too few in
 * the window" are different answers to the applicant and only this function knows which applies.
 */
export function estimateMonthlyIncome(
  transactions: readonly IncomeTransactionInput[],
  months: number = INCOME_LOOKBACK_MONTHS,
  now: Date = new Date(),
): IncomeEstimateOutcome {
  const deposits = transactions.filter(looksLikePayrollDeposit);
  const depositCount = deposits.length;
  if (depositCount === 0) return { ok: false, reason: "no_payroll_deposits", depositCount };
  if (!(months > 0)) return { ok: false, reason: "not_enough_history", depositCount };
  const today = Math.floor(now.getTime() / 86_400_000);
  const windowStart = today - INCOME_WINDOW_DAYS;
  const counted = deposits.filter((txn) => {
    const day = dayNumber(txn.date);
    return day !== null && day >= windowStart && day <= today;
  });
  if (counted.length < INCOME_MIN_DEPOSITS) return { ok: false, reason: "not_enough_history", depositCount };
  const totalCents = counted.reduce((sum, txn) => sum + Math.round(Math.abs(txn.amount) * 100), 0);
  const monthlyIncomeCents = Math.round(totalCents / months);
  if (monthlyIncomeCents <= 0) return { ok: false, reason: "no_payroll_deposits", depositCount };
  return { ok: true, estimate: { monthlyIncomeCents, months, depositCount: counted.length } };
}
