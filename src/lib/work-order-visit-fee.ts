/**
 * Estimate-visit fee primitives: dependency-free so server routes, invoice code and the UI can all
 * import them without pulling client modules (see work-order-bid-cycle.ts for the cycle itself).
 */

/** Sanity ceiling on a vendor-set estimate visit fee ($1,000). */
export const MAX_ESTIMATE_VISIT_FEE_CENTS = 100_000;

/** Invoice-number prefix marking an estimate-visit fee invoice (one per bid). */
export const VISIT_FEE_INVOICE_PREFIX = "VISIT-";

export function visitFeeInvoiceNumber(bidId: string): string {
  return `${VISIT_FEE_INVOICE_PREFIX}${bidId}`;
}

export function isVisitFeeInvoiceNumber(invoiceNumber: string | null | undefined): boolean {
  return typeof invoiceNumber === "string" && invoiceNumber.startsWith(VISIT_FEE_INVOICE_PREFIX);
}

/** Whole-cent visit fee in [0, MAX], or null when the input is not a valid fee. Empty = free visit. */
export function parseVisitFeeCents(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return 0;
  const cents = Math.round(Number(raw));
  if (!Number.isFinite(cents) || cents < 0 || cents > MAX_ESTIMATE_VISIT_FEE_CENTS) return null;
  return cents;
}
