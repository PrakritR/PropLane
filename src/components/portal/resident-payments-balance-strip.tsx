"use client";

import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { StatTile } from "@/components/portal/portal-record-overview-kit";
import { parseMoneyAmount } from "@/lib/parse-money";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export type ResidentBalanceStrip = {
  balance: string;
  overdue: boolean;
  nextPayment: string;
  paidThisYear: string;
};

/** The three facts above a resident's payment lists, derived only from the ledger rows. */
export function residentBalanceStrip(
  rows: DemoManagerPaymentLedgerRow[],
  now: Date = new Date(),
): ResidentBalanceStrip {
  const unpaid = rows.filter((r) => r.bucket !== "paid");
  const balance = unpaid.reduce((sum, r) => sum + parseMoneyAmount(r.balanceDue), 0);
  const upcoming = unpaid
    .filter((r) => r.bucket === "pending" && r.dueDateSortMs != null)
    .sort((a, b) => (a.dueDateSortMs ?? 0) - (b.dueDateSortMs ?? 0))[0];
  const nextPayment = upcoming
    ? `${new Date(upcoming.dueDateSortMs as number).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${usd.format(parseMoneyAmount(upcoming.balanceDue || upcoming.lineAmount))}`
    : "None due";
  const paid = rows
    .filter(
      (r) =>
        r.bucket === "paid" &&
        (r.dueDateSortMs == null || new Date(r.dueDateSortMs).getFullYear() === now.getFullYear()),
    )
    .reduce((sum, r) => sum + parseMoneyAmount(r.amountPaid || r.lineAmount), 0);
  return {
    balance: usd.format(balance),
    overdue: unpaid.some((r) => r.bucket === "overdue"),
    nextPayment,
    paidThisYear: usd.format(paid),
  };
}

export function ResidentPaymentsBalanceStrip({ rows }: { rows: DemoManagerPaymentLedgerRow[] }) {
  const strip = residentBalanceStrip(rows);
  return (
    <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3" data-attr="resident-payments-balance-strip">
      <StatTile
        label="Balance"
        value={strip.balance}
        tone={strip.overdue ? "danger" : "default"}
        dataAttr="resident-payments-balance"
      />
      <StatTile label="Next payment" value={strip.nextPayment} dataAttr="resident-payments-next" />
      <StatTile label="Paid this year" value={strip.paidThisYear} dataAttr="resident-payments-paid-year" />
    </div>
  );
}
