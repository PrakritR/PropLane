/**
 * Incoming payments > Send reminder rules, shared by the row menu (what to offer) and
 * `POST /api/vendor/invoices/[id]/remind` (what to allow).
 */

/** One reminder per invoice per 24 hours, stored on the invoice row so it holds across devices. */
export const VENDOR_INVOICE_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** A reminder is only for an invoice the manager has approved and not yet paid (overdue is a due date on one of these). */
export const VENDOR_INVOICE_REMINDABLE_STATUSES = ["approved", "scheduled"] as const;

export function isVendorInvoiceRemindable(status: string): boolean {
  return (VENDOR_INVOICE_REMINDABLE_STATUSES as readonly string[]).includes(status);
}
