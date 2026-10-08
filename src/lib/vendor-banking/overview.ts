/**
 * Vendor Finances > Overview (vendor-portal-ia-1007): the pure derivation behind
 * `GET /api/vendor/finances/overview`. Every figure is computed on the server from the vendor's
 * own rows and sent as integer cents; the client only formats. Client-safe (no server imports).
 *
 *  - Earned: what the vendor actually received from managers. The vendor ledger is the source
 *    (`charge` + the PropLane fee debit + refunds + a returned hold fee), plus any invoice paid
 *    off the PropLane rail (a manager marked it paid offline) that the ledger never saw.
 *  - Spent: `vendor_expense_entries`.
 *  - Owed to you: invoices a manager approved or scheduled and has not paid.
 */
import { pacificCalendarMonthKey, pacificCalendarYear } from "@/lib/pacific-time";

export type OverviewLedgerLine = {
  kind: string;
  amountCents: number;
  source: string;
  sourceId: string | null;
  managerUserId: string | null;
  createdAt: string;
};

export type OverviewInvoice = {
  id: string;
  managerUserId: string | null;
  status: string;
  totalCents: number;
  paidAt: string | null;
};

export type OverviewExpense = {
  amountCents: number;
  /** yyyy-mm-dd */
  expenseDate: string;
  /** The manager of the service the expense is tied to; null when it is tied to none. */
  managerUserId: string | null;
};

export type VendorOverviewManagerRow = {
  managerUserId: string | null;
  earnedCents: number;
  spentCents: number;
  profitCents: number;
};

export type VendorOverviewFigures = {
  /** yyyy-mm of the month strip. */
  monthKey: string;
  month: { earnedCents: number; spentCents: number; profitCents: number; jobs: number };
  owedCents: number;
  paidThisYearCents: number;
  /** The whole ledger's running total - the balance fallback when Stripe cannot answer. */
  ledgerBalanceCents: number;
  byManager: VendorOverviewManagerRow[];
};

/** Signed contribution of one ledger line to what the vendor earned (0 for lines that only move money around). */
export function earnedContributionCents(line: Pick<OverviewLedgerLine, "kind" | "amountCents" | "source">): number {
  if (line.kind === "charge") return line.amountCents;
  if (line.kind === "platform_fee") return -Math.abs(line.amountCents);
  if (line.kind === "refund") return -Math.abs(line.amountCents);
  // A hold that expired returns the fee that was taken against it.
  if (line.kind === "adjustment" && line.source === "hold_expiry" && line.amountCents > 0) return line.amountCents;
  return 0;
}

export function deriveVendorOverview(input: {
  ledger: readonly OverviewLedgerLine[];
  invoices: readonly OverviewInvoice[];
  expenses: readonly OverviewExpense[];
  /** yyyy-mm-dd on the Pacific calendar. */
  today: string;
}): VendorOverviewFigures {
  const monthKey = input.today.slice(0, 7);
  const year = Number(input.today.slice(0, 4));

  let earnedMonth = 0;
  let paidThisYear = 0;
  let ledgerBalance = 0;
  const jobIds = new Set<string>();
  const earnedByManager = new Map<string | null, number>();
  const invoicesOnLedger = new Set<string>();

  const addEarned = (managerUserId: string | null, cents: number) => {
    earnedByManager.set(managerUserId, (earnedByManager.get(managerUserId) ?? 0) + cents);
  };

  for (const line of input.ledger) {
    ledgerBalance += line.amountCents;
    if (line.kind === "charge" && line.source === "invoice" && line.sourceId) invoicesOnLedger.add(line.sourceId);
    const contribution = earnedContributionCents(line);
    if (contribution === 0) continue;
    if (pacificCalendarYear(line.createdAt) === year) paidThisYear += contribution;
    if (pacificCalendarMonthKey(line.createdAt) === monthKey) {
      earnedMonth += contribution;
      addEarned(line.managerUserId, contribution);
      if (line.kind === "charge" && line.sourceId) jobIds.add(`${line.source}:${line.sourceId}`);
    }
  }

  let owed = 0;
  for (const invoice of input.invoices) {
    if (invoice.status === "approved" || invoice.status === "scheduled") owed += invoice.totalCents;
    // Paid off the PropLane rail: the ledger has no line for it, so it counts here, once.
    if (invoice.status === "paid" && invoice.paidAt && !invoicesOnLedger.has(invoice.id)) {
      if (pacificCalendarYear(invoice.paidAt) === year) paidThisYear += invoice.totalCents;
      if (pacificCalendarMonthKey(invoice.paidAt) === monthKey) {
        earnedMonth += invoice.totalCents;
        addEarned(invoice.managerUserId, invoice.totalCents);
        jobIds.add(`invoice:${invoice.id}`);
      }
    }
  }

  let spentMonth = 0;
  const spentByManager = new Map<string | null, number>();
  for (const expense of input.expenses) {
    if (expense.expenseDate.slice(0, 7) !== monthKey) continue;
    spentMonth += expense.amountCents;
    spentByManager.set(expense.managerUserId, (spentByManager.get(expense.managerUserId) ?? 0) + expense.amountCents);
  }

  const managerKeys = new Set<string | null>([...earnedByManager.keys(), ...spentByManager.keys()]);
  const byManager = [...managerKeys]
    .map((managerUserId) => {
      const earnedCents = earnedByManager.get(managerUserId) ?? 0;
      const spentCents = spentByManager.get(managerUserId) ?? 0;
      return { managerUserId, earnedCents, spentCents, profitCents: earnedCents - spentCents };
    })
    .sort((a, b) => b.earnedCents - a.earnedCents || b.spentCents - a.spentCents);

  return {
    monthKey,
    month: { earnedCents: earnedMonth, spentCents: spentMonth, profitCents: earnedMonth - spentMonth, jobs: jobIds.size },
    owedCents: owed,
    paidThisYearCents: paidThisYear,
    ledgerBalanceCents: ledgerBalance,
    byManager,
  };
}

/** What the Overview route sends. `stripe` is the live Connect balance; `ledger` is the fallback when Stripe cannot answer. */
export type VendorFinancesOverview = {
  balance: {
    source: "stripe" | "ledger";
    availableCents: number;
    /** Null when Stripe cannot say (money on its way to the bank is only known to Stripe). */
    pendingCents: number | null;
    owedCents: number;
    paidThisYearCents: number;
    currency: string;
  };
  stripeUnavailable: boolean;
  month: VendorOverviewFigures["month"] & { monthKey: string };
  byManager: Array<VendorOverviewManagerRow & { label: string }>;
};
