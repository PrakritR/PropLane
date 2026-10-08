/**
 * Vendor Payments (VD10-VD14) — Income (derived from completed work orders +
 * their payouts, `vendor-income.ts`) and Invoices (`vendor_invoices`,
 * `vendor-invoices.ts`) merge into ONE flat, newest-first list instead of two
 * tabs. Neither source's own shape changes; this module only normalizes both
 * into a shared row for the merged list, the unified filter, and the row
 * menu. `VendorPaymentRow` keeps the original `income`/`invoice` object
 * attached so a later pass (gross/fee/net breakdown, balance buckets — see
 * VD40-VD55) can read off it without reshaping this merge.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { formatVendorIncomeMoney, type VendorIncomeRow } from "@/lib/vendor-income";
import { formatInvoiceMoney, vendorInvoiceStatusLabel, type VendorInvoice, type VendorInvoiceStatus } from "@/lib/vendor-invoices";
import type { VendorPayout } from "@/lib/vendor-payouts";

export type VendorPaymentRowKind = "income" | "invoice";

export type VendorPaymentRow = {
  id: string;
  kind: VendorPaymentRowKind;
  title: string;
  propertyId: string;
  propertyLabel: string | null;
  dateIso: string;
  statusId: string;
  statusLabel: string;
  amountCents: number;
  currency: string;
  /** Set for an income row with a matching `vendor_payouts` row — the row's own View target. */
  payoutId: string | null;
  /** The manager the money comes from, when the row's job (or the vendor's only linked manager) names one. */
  managerLabel: string | null;
  /** The manager's user id when known (an invoice's payer, or the job's owner) - the target of "Message manager". */
  managerUserId: string | null;
  /** The invoice number, kept for search when `title` is the service's own title. */
  reference: string | null;
  /** The invoice's payment due date (yyyy-mm-dd) from the manager's bill; null when none is set. */
  dueIso: string | null;
  /** The row's own source record — the extension point for fee/net work. */
  income: VendorIncomeRow | null;
  invoice: VendorInvoice | null;
  /**
   * VD43 — the matching `vendor_payouts` row for either kind (income by
   * work_order_id, invoice by invoice_id), when one exists. `platformFeeCents`
   * on it is 0 for anything settled before VENDOR_BANKING_ENABLED or with the
   * flag off, which is exactly what keeps a fee-less row's display unchanged.
   */
  payout: VendorPayout | null;
};

function incomeStatusId(row: VendorIncomeRow): string {
  return `income:${row.payoutStatus}`;
}

function invoiceStatusId(status: VendorInvoiceStatus): string {
  return `invoice:${status}`;
}

function jobPropertyLabel(job: DemoManagerWorkOrderRow | undefined): { id: string; label: string | null } {
  if (!job) return { id: "", label: null };
  const unit = job.unit?.trim();
  const label = unit && unit !== "—" ? `${job.propertyName} · ${unit}` : job.propertyName;
  return { id: job.propertyId ?? job.assignedPropertyId ?? "", label: label || null };
}

export function vendorPaymentRowFromIncome(
  row: VendorIncomeRow,
  payout?: VendorPayout,
  managerLabel: string | null = null,
  managerUserId: string | null = null,
): VendorPaymentRow {
  return {
    id: `income:${row.id}`,
    kind: "income",
    title: row.workOrderTitle,
    propertyId: row.propertyId,
    propertyLabel: row.propertyLabel || null,
    dateIso: row.dateIso,
    statusId: incomeStatusId(row),
    statusLabel: row.payoutStatusLabel,
    amountCents: row.totalCents,
    currency: "usd",
    payoutId: payout?.id ?? null,
    managerLabel,
    managerUserId,
    reference: null,
    dueIso: null,
    income: row,
    invoice: null,
    payout: payout ?? null,
  };
}

/**
 * `jobsById` backfills a property for an invoice row when it is linked to a
 * work order — `VendorInvoice` itself carries no property field — so the
 * merged list's property filter can apply to invoice rows too.
 */
export function vendorPaymentRowFromInvoice(
  invoice: VendorInvoice,
  jobsById: Record<string, DemoManagerWorkOrderRow>,
  payout?: VendorPayout,
  defaultManagerLabel: string | null = null,
): VendorPaymentRow {
  const job = invoice.workOrderId ? jobsById[invoice.workOrderId] : undefined;
  const property = jobPropertyLabel(job);
  const reference = invoice.invoiceNumber?.trim() || null;
  return {
    id: `invoice:${invoice.id}`,
    kind: "invoice",
    // The service the invoice bills for; a bare invoice (no job) reads by its number.
    title: job?.title?.trim() || reference || "Invoice",
    propertyId: property.id,
    propertyLabel: property.label,
    dateIso: invoice.submittedAt,
    statusId: invoiceStatusId(invoice.status),
    statusLabel: vendorInvoiceStatusLabel(invoice.status),
    amountCents: invoice.totalCents,
    currency: invoice.currency,
    payoutId: payout?.id ?? null,
    managerLabel: job?.managerName?.trim() || defaultManagerLabel,
    managerUserId: invoice.managerUserId?.trim() || job?.managerUserId?.trim() || null,
    reference,
    dueIso: invoice.dueDate?.slice(0, 10) || null,
    income: null,
    invoice,
    payout: payout ?? null,
  };
}

export function buildVendorPaymentRows(
  incomeRows: VendorIncomeRow[],
  invoices: VendorInvoice[],
  jobsById: Record<string, DemoManagerWorkOrderRow>,
  payoutsByWorkOrderId: Record<string, VendorPayout>,
  payoutsByInvoiceId: Record<string, VendorPayout> = {},
  /** Names the manager on an invoice with no job — the vendor's only linked manager, when there is exactly one. */
  defaultManagerLabel: string | null = null,
): VendorPaymentRow[] {
  const rows = [
    ...incomeRows.map((row) =>
      vendorPaymentRowFromIncome(
        row,
        payoutsByWorkOrderId[row.workOrderId],
        jobsById[row.workOrderId]?.managerName?.trim() || defaultManagerLabel,
        jobsById[row.workOrderId]?.managerUserId?.trim() || null,
      ),
    ),
    ...invoices.map((invoice) =>
      vendorPaymentRowFromInvoice(invoice, jobsById, payoutsByInvoiceId[invoice.id], defaultManagerLabel),
    ),
  ];
  // Newest first — the merge's whole point (VD11).
  return rows.sort((a, b) => (a.dateIso < b.dateIso ? 1 : a.dateIso > b.dateIso ? -1 : 0));
}

/** Gross / PropLane fee / net breakdown for a row's matched payout — null unless a real fee was ever taken (VD43). */
export function vendorPaymentFeeBreakdown(
  payout: VendorPayout | null,
): { grossCents: number; feeCents: number; netCents: number } | null {
  if (!payout || !payout.platformFeeCents || payout.platformFeeCents <= 0) return null;
  const grossCents = payout.amountCents;
  const feeCents = payout.platformFeeCents;
  return { grossCents, feeCents, netCents: Math.max(0, grossCents - feeCents) };
}

export type VendorPaymentDetailBreakdown = {
  grossCents: number;
  feeCents: number;
  netCents: number;
  refundedGrossCents: number;
};

/**
 * VD53 — the payment detail page's full amount card (gross / PropLane fee /
 * net / refunded). Unlike {@link vendorPaymentFeeBreakdown} (used by the flat
 * list, which hides the row entirely when no fee was ever taken), the detail
 * page always shows every figure — a legacy pre-VENDOR_BANKING_ENABLED
 * payment simply shows a 0 fee and 0 refunded, never a missing row. Every
 * amount floors at 0 and the fee never exceeds gross, mirroring the
 * server-side invariant in `platform-fees.ts`'s `vendorPayFeeCents`.
 */
export function vendorPaymentDetailBreakdown(payout: VendorPayout): VendorPaymentDetailBreakdown {
  const grossCents = Math.max(0, Math.round(payout.amountCents));
  const feeCents = Math.min(grossCents, Math.max(0, Math.round(payout.platformFeeCents ?? 0)));
  const refundedGrossCents = Math.min(grossCents, Math.max(0, Math.round(payout.refundedGrossCents ?? 0)));
  return { grossCents, feeCents, netCents: Math.max(0, grossCents - feeCents), refundedGrossCents };
}

export type VendorPaymentTimelineStepId = "paid" | "held" | "transferred" | "withdrawn";
export type VendorPaymentTimelineState = "done" | "pending" | "skipped";
export type VendorPaymentTimelineStep = {
  id: VendorPaymentTimelineStepId;
  label: string;
  state: VendorPaymentTimelineState;
  detail: string | null;
};

/**
 * VD52 — "Paid by manager → In your PropLane balance → Transferred to your
 * account → Withdrawn", for one payment received. Stripe balances are
 * fungible once money lands in the vendor's connected account, so the last
 * two steps are the best HONEST read of where a specific payment's money
 * probably sits today, not a byte-exact trace of that one dollar:
 *
 * - "Paid by manager": done once the manager's charge settled (any status
 *   other than pending/failed/skipped) — still done even if later refunded.
 * - "In your PropLane balance": done the same moment as "Paid" — every
 *   settled payment lands in a PropLane-mediated balance first, whether or
 *   not it stays there.
 * - "Transferred to your account": a `destination_charge` payout reaches the
 *   vendor's own connected Stripe balance immediately, so this is done as
 *   soon as it is paid. A `hold` payout (no bank yet at charge time) is only
 *   marked transferred once `bankReady` is true — the existing auto-transfer
 *   job moves a hold the moment the vendor's bank is ready, so a ready bank
 *   is the honest signal that any past hold has since cleared. Absent
 *   `destination` (a row written before this column existed) is treated as
 *   `hold`, the safer assumption.
 * - "Withdrawn": no single payment keeps its own withdrawal record once
 *   pooled into the vendor's Stripe balance, so this is inferred from
 *   `lastWithdrawalAt` (the vendor's most recent successful payout-to-bank) —
 *   done only when that withdrawal happened AFTER this payment transferred.
 *   Never claimed with more certainty than that.
 */
export function vendorPaymentStatusTimeline(
  payout: VendorPayout,
  opts: { bankReady: boolean; lastWithdrawalAt?: string | null },
): VendorPaymentTimelineStep[] {
  const paidDone = payout.status !== "pending" && payout.status !== "failed" && payout.status !== "skipped";
  const transferredAt = payout.updatedAt ?? payout.createdAt;
  const isDestinationCharge = payout.destination === "destination_charge";
  const transferredDone = paidDone && (isDestinationCharge || opts.bankReady);
  const withdrawnDone =
    transferredDone && Boolean(opts.lastWithdrawalAt) && new Date(opts.lastWithdrawalAt as string).getTime() > new Date(transferredAt).getTime();

  return [
    {
      id: "paid",
      label: "Paid by manager",
      state: paidDone ? "done" : "pending",
      detail: null,
    },
    {
      id: "held",
      label: "In your PropLane balance",
      state: !paidDone ? "pending" : "done",
      detail: null,
    },
    {
      id: "transferred",
      label: "Transferred to your account",
      state: !paidDone ? "pending" : transferredDone ? "done" : "pending",
      detail: !paidDone || transferredDone ? null : "Waiting on your bank — add one to release it.",
    },
    {
      id: "withdrawn",
      label: "Withdrawn",
      state: !transferredDone ? "pending" : withdrawnDone ? "done" : "pending",
      detail: transferredDone && !withdrawnDone ? "Still in your available balance." : null,
    },
  ];
}

export function formatVendorPaymentMoney(row: VendorPaymentRow): string {
  return row.kind === "invoice" ? formatInvoiceMoney(row.amountCents, row.currency) : formatVendorIncomeMoney(row.amountCents);
}

export type VendorPaymentStatusOption = { id: string; label: string };

/** Derived from the rows actually present rather than a hardcoded union, so a status that never occurs never shows as a dead filter option. */
export function vendorPaymentStatusOptions(rows: VendorPaymentRow[]): VendorPaymentStatusOption[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (!byId.has(row.statusId)) byId.set(row.statusId, row.statusLabel);
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export function buildVendorPaymentPropertyFilterOptions(rows: VendorPaymentRow[]): { id: string; label: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (!row.propertyId || !row.propertyLabel) continue;
    if (!byId.has(row.propertyId)) byId.set(row.propertyId, row.propertyLabel);
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export type VendorPaymentFilters = {
  from: string;
  to: string;
  propertyIds: string[];
  statusIds: string[];
  query: string;
};

function inDateRange(dateIso: string, from: string, to: string): boolean {
  if (!dateIso) return true;
  const day = dateIso.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function filterVendorPaymentRows(rows: VendorPaymentRow[], filters: VendorPaymentFilters): VendorPaymentRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.statusIds.length > 0 && !filters.statusIds.includes(row.statusId)) return false;
    if (filters.propertyIds.length > 0 && !filters.propertyIds.includes(row.propertyId)) return false;
    if (query) {
      const haystack = `${row.title} ${row.reference ?? ""} ${row.managerLabel ?? ""} ${row.propertyLabel ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return inDateRange(row.dateIso, filters.from, filters.to);
  });
}

/**
 * Payments tabs (vendor-portal-redesign-1006): Pending · Paid · Overdue.
 * Overdue is an invoice past its due date and still unpaid; "past" is a
 * calendar-day comparison against `today` (yyyy-mm-dd), so a payment due today
 * is still pending. An invoice with no due date can never be overdue.
 */
export type VendorPaymentBucket = "pending" | "paid" | "overdue";

export const VENDOR_PAYMENT_BUCKETS: { id: VendorPaymentBucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "paid", label: "Paid" },
  { id: "overdue", label: "Overdue" },
];

export function vendorPaymentBucket(row: VendorPaymentRow, today: string): VendorPaymentBucket {
  if (row.statusId === "income:paid" || row.statusId === "invoice:paid") return "paid";
  if (row.kind === "invoice" && row.statusId !== "invoice:rejected" && row.dueIso && row.dueIso < today) return "overdue";
  return "pending";
}

export function vendorPaymentBucketCounts(rows: VendorPaymentRow[], today: string): Record<VendorPaymentBucket, number> {
  const counts: Record<VendorPaymentBucket, number> = { pending: 0, paid: 0, overdue: 0 };
  for (const row of rows) counts[vendorPaymentBucket(row, today)] += 1;
  return counts;
}
