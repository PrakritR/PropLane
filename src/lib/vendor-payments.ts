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

export function vendorPaymentRowFromIncome(row: VendorIncomeRow, payout?: VendorPayout): VendorPaymentRow {
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
): VendorPaymentRow {
  const job = invoice.workOrderId ? jobsById[invoice.workOrderId] : undefined;
  const property = jobPropertyLabel(job);
  return {
    id: `invoice:${invoice.id}`,
    kind: "invoice",
    title: invoice.invoiceNumber || "Invoice",
    propertyId: property.id,
    propertyLabel: property.label,
    dateIso: invoice.submittedAt,
    statusId: invoiceStatusId(invoice.status),
    statusLabel: vendorInvoiceStatusLabel(invoice.status),
    amountCents: invoice.totalCents,
    currency: invoice.currency,
    payoutId: payout?.id ?? null,
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
): VendorPaymentRow[] {
  const rows = [
    ...incomeRows.map((row) => vendorPaymentRowFromIncome(row, payoutsByWorkOrderId[row.workOrderId])),
    ...invoices.map((invoice) => vendorPaymentRowFromInvoice(invoice, jobsById, payoutsByInvoiceId[invoice.id])),
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
      const haystack = `${row.title} ${row.propertyLabel ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return inDateRange(row.dateIso, filters.from, filters.to);
  });
}
