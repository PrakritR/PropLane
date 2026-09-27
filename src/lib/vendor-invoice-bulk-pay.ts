/**
 * U043 (C260): "Pay vendors" bulk-pay math — which approved invoices a single
 * click can clear from the manager's PropLane balance right now. Pure and
 * side-effect-free so the money math has its own unit coverage separate from
 * the UI that calls the real per-invoice `pay-from-balance` route
 * (`POST /api/vendor/invoices/[id]/pay-from-balance`) once per selected id.
 *
 * This is a CLIENT-SIDE PREVIEW only, mirroring the studio mock's
 * `ops.payAllApprovedInvoices` running-balance greedy pick in list order. It
 * decides which invoices to ATTEMPT, never what actually gets paid — the
 * server re-checks the real balance and status for every invoice, same as a
 * single "Pay from balance" click already does (see the route's own
 * `insufficient_balance` 422), so a stale or wrong preview here can only
 * under- or over-attempt, never mis-charge.
 */
export type PayableVendorInvoiceSummary = {
  id: string;
  totalCents: number;
};

/**
 * Greedy running-balance pick in list order: an invoice that fits is taken
 * (and its amount reserved against the running balance); one that does not
 * fit is skipped WITHOUT stopping the pass, so a smaller invoice later in the
 * list can still be picked up. Matches the mock's `ops.payAllApprovedInvoices`
 * exactly. An invoice with a non-positive total is never selected — there is
 * nothing to pay and nothing to reserve.
 */
export function selectVendorInvoicesWithinBalance(
  invoices: PayableVendorInvoiceSummary[],
  availableCents: number,
): string[] {
  let running = availableCents;
  const payable: string[] = [];
  for (const invoice of invoices) {
    if (invoice.totalCents <= 0) continue;
    if (invoice.totalCents > running) continue;
    running -= invoice.totalCents;
    payable.push(invoice.id);
  }
  return payable;
}

/** Cents still needed beyond `availableCents` to pay this one invoice — 0 when it already fits. */
export function vendorInvoiceShortfallCents(totalCents: number, availableCents: number): number {
  return Math.max(0, totalCents - availableCents);
}
