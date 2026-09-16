import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { workOrderEvent } from "@/lib/work-order-events.server";

/**
 * The vendor's side of an invoice decision: `invoice_approved` when the
 * manager accepts, `invoice_disputed` (with the manager's note) when they
 * reject. Rides the work-order bus so the vendor's own Invoices row gates it.
 */
export async function notifyVendorOfInvoiceDecision(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    vendorUserId: string;
    invoiceId: string;
    workOrderId: string | null;
    totalCents: number;
    decision: "approved" | "rejected";
    note?: string;
  },
): Promise<void> {
  const { data: manager } = await db.from("profiles").select("email, full_name").eq("id", input.managerUserId).maybeSingle();
  const senderEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  let workOrder: DemoManagerWorkOrderRow | null = null;
  if (input.workOrderId) {
    const { data } = await db.from("portal_work_order_records").select("row_data").eq("id", input.workOrderId).maybeSingle();
    workOrder = (data?.row_data as DemoManagerWorkOrderRow | undefined) ?? null;
  }
  await workOrderEvent(db, {
    eventId: `invoice:${input.invoiceId}:${input.decision}`,
    event: input.decision === "approved" ? "invoice_approved" : "invoice_disputed",
    managerUserId: input.managerUserId,
    workOrderId: input.workOrderId ?? `invoice:${input.invoiceId}`,
    senderUserId: input.managerUserId,
    senderEmail,
    senderName: String(manager?.full_name ?? "").trim() || undefined,
    facts: {
      reference: workOrder?.reference || "Invoice",
      title: workOrder?.title || "your work",
      propertyLabel: workOrder?.propertyName || undefined,
      amountCents: input.totalCents,
      note: input.note?.trim() || undefined,
    },
    recipients: [{ audience: "vendor", userId: input.vendorUserId }],
  });
}
