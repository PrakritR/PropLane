import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { resolveWorkOrderAssignee } from "@/lib/manager-service-workflow";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";
import { insertVendorInvoiceRow, type PreparedVendorInvoiceSubmission } from "@/lib/vendor-invoice-submit.server";

async function workOrderInvoiceTotalCents(
  db: SupabaseClient,
  workOrderId: string,
  row: DemoManagerWorkOrderRow,
): Promise<number> {
  const { data: bid } = await db
    .from("work_order_bids")
    .select("amount_cents, materials_cents, status")
    .eq("work_order_id", workOrderId)
    .eq("status", "accepted")
    .maybeSingle();
  if (bid?.amount_cents != null) {
    const labor = Number(bid.amount_cents);
    const materials = Number(bid.materials_cents ?? 0);
    if (Number.isSafeInteger(labor) && Number.isSafeInteger(materials) && labor + materials > 0) {
      return labor + materials;
    }
  }
  const labor = row.vendorCostCents ?? 0;
  const materials = row.materialsCostCents ?? 0;
  if (labor + materials > 0) return labor + materials;
  return 0;
}

/**
 * When a vendor marks a job done, ensure a submitted invoice exists for manager
 * approval (C2-SVC2). Team/self jobs never create vendor bills.
 */
export async function ensureSubmittedVendorInvoiceForMarkedDone(
  db: SupabaseClient,
  input: {
    workOrderId: string;
    managerUserId: string;
    vendorUserId: string;
    row: DemoManagerWorkOrderRow;
  },
): Promise<void> {
  const assignee = resolveWorkOrderAssignee(input.row);
  if (input.row.selfAssigned || assignee?.kind === "team") return;
  if (!input.vendorUserId) return;

  const { data: existing } = await db
    .from("vendor_invoices")
    .select("id, status")
    .eq("work_order_id", input.workOrderId)
    .maybeSingle();
  if (existing && existing.status !== "rejected") return;

  const totalCents = await workOrderInvoiceTotalCents(db, input.workOrderId, input.row);
  if (totalCents <= 0) return;

  // The roster row under the work order's OWN manager, or none. `links` spans
  // every manager this vendor is on, so falling back to the first one filed the
  // bill under an unrelated manager - who could then see and pay an invoice for
  // a job that was never theirs, while the real manager never saw it.
  const links = await resolveOwnVendorRecords(db, input.vendorUserId);
  const target = links.find((link) => link.managerUserId === input.managerUserId);
  if (!target) {
    console.warn("[vendor-invoice] no roster row under this work order's manager; no invoice filed", {
      workOrderId: input.workOrderId,
      managerUserId: input.managerUserId,
      vendorUserId: input.vendorUserId,
      totalCents,
    });
    return;
  }

  const title = input.row.title?.trim() || "Service";
  const prepared: PreparedVendorInvoiceSubmission = {
    target,
    workOrderId: input.workOrderId,
    workOrderTitle: title,
    workOrderReference: input.row.reference?.trim() || null,
    lineItems: [{ description: title, quantity: 1, unitAmountCents: totalCents, amountCents: totalCents }],
    subtotalCents: totalCents,
    taxCents: 0,
    totalCents,
  };
  const now = new Date().toISOString();
  const { error } = await insertVendorInvoiceRow(db, prepared, {
    vendorUserId: input.vendorUserId,
    memo: title,
    now,
  });
  if (error) throw new Error(error.message);
}
