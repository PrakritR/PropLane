import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";
import { insertVendorInvoiceRow, type PreparedVendorInvoiceSubmission } from "@/lib/vendor-invoice-submit.server";
import { isVisitFeeInvoiceNumber, visitFeeInvoiceNumber, VISIT_FEE_INVOICE_PREFIX } from "@/lib/work-order-visit-fee";

/**
 * The estimate-visit fee is the manager's own outgoing payment: it rides the SAME vendor-invoice
 * rail as a finished job (Approve & pay -> bill -> Stripe / balance), as a second invoice on the
 * service. Exactly one per bid, keyed by `VISIT-<bid id>` (unique index in
 * 20261003231000_work_order_bid_estimates.sql). The amount is read from the stored bid row,
 * never from a request body.
 */
export async function ensureVisitFeeInvoice(
  db: SupabaseClient,
  input: {
    bidId: string;
    workOrderId: string;
    managerUserId: string;
    vendorUserId: string;
    feeCents: number;
    title: string;
    reference?: string | null;
  },
): Promise<{ created: boolean }> {
  if (!Number.isSafeInteger(input.feeCents) || input.feeCents <= 0) return { created: false };
  const invoiceNumber = visitFeeInvoiceNumber(input.bidId);

  const { data: existing } = await db
    .from("vendor_invoices")
    .select("id, status")
    .eq("work_order_id", input.workOrderId)
    .eq("invoice_number", invoiceNumber)
    .limit(1);
  if (existing && existing.length > 0 && (existing[0] as { status?: string }).status !== "rejected") {
    return { created: false };
  }

  // The roster row under the service's OWN manager, or none (same rule as the job invoice).
  const links = await resolveOwnVendorRecords(db, input.vendorUserId);
  const target = links.find((link) => link.managerUserId === input.managerUserId);
  if (!target) {
    console.warn("[visit-fee-invoice] no roster row under this service's manager; no invoice filed", {
      workOrderId: input.workOrderId,
      bidId: input.bidId,
    });
    return { created: false };
  }

  const title = input.title.trim() || "Service";
  const description = `Estimate visit · ${title}`;
  const prepared: PreparedVendorInvoiceSubmission = {
    target,
    workOrderId: input.workOrderId,
    workOrderTitle: title,
    workOrderReference: input.reference?.trim() || null,
    lineItems: [{ description, quantity: 1, unitAmountCents: input.feeCents, amountCents: input.feeCents }],
    subtotalCents: input.feeCents,
    taxCents: 0,
    totalCents: input.feeCents,
  };
  const { error } = await insertVendorInvoiceRow(db, prepared, {
    vendorUserId: input.vendorUserId,
    invoiceNumber,
    memo: description,
    now: new Date().toISOString(),
  });
  if (error) {
    // 23505 = the unique index: a racing call already filed it, which is the outcome we want.
    if ((error as { code?: string }).code === "23505") return { created: false };
    throw new Error(error.message);
  }
  return { created: true };
}

/**
 * True only for a visit-fee invoice that matches a real bid: same service, same vendor, same
 * manager, the visit marked done, and the invoice total equal to the fee stored on that bid.
 * A vendor typing "VISIT-..." into a self-filed invoice therefore cannot make it payable.
 */
export async function isGenuineVisitFeeInvoice(
  db: SupabaseClient,
  invoice: {
    invoice_number?: string | null;
    work_order_id?: string | null;
    vendor_user_id?: string | null;
    manager_user_id?: string | null;
    total_cents?: number | null;
  },
): Promise<boolean> {
  if (!isVisitFeeInvoiceNumber(invoice.invoice_number)) return false;
  const bidId = String(invoice.invoice_number).slice(VISIT_FEE_INVOICE_PREFIX.length);
  if (!bidId || !invoice.work_order_id) return false;
  const { data: bid } = await db
    .from("work_order_bids")
    .select("id, work_order_id, vendor_user_id, manager_user_id, estimate_visit_done_at, estimate_visit_fee_cents")
    .eq("id", bidId)
    .maybeSingle();
  if (!bid) return false;
  return (
    bid.work_order_id === invoice.work_order_id &&
    bid.vendor_user_id === invoice.vendor_user_id &&
    bid.manager_user_id === invoice.manager_user_id &&
    Boolean(bid.estimate_visit_done_at) &&
    Number(bid.estimate_visit_fee_cents) > 0 &&
    Number(bid.estimate_visit_fee_cents) === Number(invoice.total_cents)
  );
}
