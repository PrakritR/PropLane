/**
 * Vendor invoice shared types + helpers, used by the vendor portal UI, the
 * `/api/vendor/invoices` routes, and the vendor-financials AI tools. Money is
 * always integer cents; the model / UI never recomputes totals from raw input
 * beyond summing line items server-side.
 */

export const VENDOR_INVOICE_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "scheduled",
  "paid",
] as const;

export type VendorInvoiceStatus = (typeof VENDOR_INVOICE_STATUSES)[number];

/**
 * Legal status transitions: submitted → approved / rejected → scheduled → paid
 * (scheduling is optional — approved may go straight to paid). `paid` and
 * `rejected` are terminal, and repeating the current status is not a
 * transition, so analytics never double-fire on repeat PATCHes.
 */
export const VENDOR_INVOICE_ALLOWED_TRANSITIONS: Record<VendorInvoiceStatus, readonly VendorInvoiceStatus[]> = {
  submitted: ["approved", "rejected"],
  approved: ["scheduled", "paid"],
  scheduled: ["paid"],
  paid: [],
  rejected: [],
};

export function canTransitionVendorInvoice(from: VendorInvoiceStatus, to: VendorInvoiceStatus): boolean {
  return (VENDOR_INVOICE_ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export type VendorInvoiceLineItem = {
  description: string;
  quantity: number;
  unitAmountCents: number;
  amountCents: number;
};

export type VendorInvoice = {
  id: string;
  vendorId: string;
  workOrderId: string | null;
  invoiceNumber: string | null;
  lineItems: VendorInvoiceLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  status: VendorInvoiceStatus;
  memo: string | null;
  decisionNote: string | null;
  billId: string | null;
  submittedAt: string;
  decidedAt: string | null;
  paidAt: string | null;
  /** Which rail settled the invoice. `null`/`"stripe"` reads as the historical ACH Checkout path (night/vendor-pay). */
  paidFrom: "stripe" | "balance" | null;
};

/** Map an invoice status onto the four shared `Badge` tones (no fifth color). */
export function vendorInvoiceBadgeTone(status: VendorInvoiceStatus): "pending" | "approved" | "confirmed" | "overdue" {
  switch (status) {
    case "submitted":
      return "pending";
    case "approved":
    case "scheduled":
      return "approved";
    case "paid":
      return "confirmed";
    case "rejected":
      return "overdue";
  }
}

export function vendorInvoiceStatusLabel(status: VendorInvoiceStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Normalize raw line-item input into clean cents, recomputing each row amount. */
export function normalizeLineItems(raw: unknown): VendorInvoiceLineItem[] {
  if (!Array.isArray(raw)) return [];
  const items: VendorInvoiceLineItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const description = String(e.description ?? "").trim();
    const quantity = Math.max(0, Math.round(Number(e.quantity ?? 1) || 0));
    const unitAmountCents = Math.max(0, Math.round(Number(e.unitAmountCents ?? 0) || 0));
    if (!description && quantity === 0 && unitAmountCents === 0) continue;
    items.push({
      description,
      quantity,
      unitAmountCents,
      amountCents: quantity * unitAmountCents,
    });
  }
  return items;
}

export function sumLineItemsCents(items: VendorInvoiceLineItem[]): number {
  return items.reduce((acc, item) => acc + item.amountCents, 0);
}

/** Shape a DB row (snake_case) into the client `VendorInvoice`. */
export function mapVendorInvoiceRow(row: Record<string, unknown>): VendorInvoice {
  return {
    id: String(row.id),
    vendorId: String(row.vendor_id ?? ""),
    workOrderId: (row.work_order_id as string | null) ?? null,
    invoiceNumber: (row.invoice_number as string | null) ?? null,
    lineItems: normalizeLineItems(row.line_items),
    subtotalCents: Number(row.subtotal_cents ?? 0),
    taxCents: Number(row.tax_cents ?? 0),
    totalCents: Number(row.total_cents ?? 0),
    currency: String(row.currency ?? "usd"),
    status: (VENDOR_INVOICE_STATUSES as readonly string[]).includes(String(row.status))
      ? (row.status as VendorInvoiceStatus)
      : "submitted",
    memo: (row.memo as string | null) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
    billId: (row.bill_id as string | null) ?? null,
    submittedAt: String(row.submitted_at ?? row.created_at ?? ""),
    decidedAt: (row.decided_at as string | null) ?? null,
    paidAt: (row.paid_at as string | null) ?? null,
    paidFrom: row.paid_from === "balance" ? "balance" : row.paid_from === "stripe" ? "stripe" : null,
  };
}

export function formatInvoiceMoney(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

/** Columns selected from `vendor_invoices` for client/tool reads (no internal audit ids). */
export const VENDOR_INVOICE_SELECT =
  "id, vendor_id, work_order_id, invoice_number, line_items, subtotal_cents, tax_cents, total_cents, currency, status, memo, decision_note, bill_id, submitted_at, decided_at, paid_at, paid_from, created_at";
