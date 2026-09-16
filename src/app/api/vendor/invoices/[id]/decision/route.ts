import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";
import {
  canTransitionVendorInvoice,
  mapVendorInvoiceRow,
  VENDOR_INVOICE_SELECT,
  type VendorInvoiceStatus,
} from "@/lib/vendor-invoices";
import { createBillFromVendorInvoice } from "@/lib/manager-bills.server";
import { notifyVendorOfInvoiceDecision } from "@/lib/vendor-invoice-decision-notify.server";

export const runtime = "nodejs";

// Which target statuses a manager may set from the review UI, and the PostHog
// event each transition emits (paid/scheduled are lifecycle-only, no event yet).
const MANAGER_DECISIONS: Partial<Record<VendorInvoiceStatus, string | null>> = {
  approved: "vendor_invoice_approved",
  rejected: "vendor_invoice_rejected",
  scheduled: null,
  paid: null,
};

/** Manager approves / rejects / schedules / marks paid an invoice billed to them. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as { status?: string; decisionNote?: string };
    const status = body.status as VendorInvoiceStatus | undefined;
    if (!status || !(status in MANAGER_DECISIONS)) {
      return NextResponse.json({ error: "Invalid decision." }, { status: 400 });
    }

    // Scope strictly to invoices billed to this manager — never trust the id alone.
    const { data: existing, error: readError } = await auth.db
      .from("vendor_invoices")
      .select("id, status, vendor_user_id, total_cents, bill_id")
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });

    const currentStatus = existing.status as VendorInvoiceStatus;
    const isApprovalRepair = currentStatus === "approved" && status === "approved";
    if (!canTransitionVendorInvoice(currentStatus, status) && !isApprovalRepair) {
      return NextResponse.json(
        { error: `Invoice is ${currentStatus}; it cannot be marked ${status}.` },
        { status: 409 },
      );
    }

    if (currentStatus === "approved") {
      try {
        await createBillFromVendorInvoice(auth.db, auth.userId, id);
      } catch (error) {
        console.error("Failed to repair approved vendor invoice bill", error);
        return NextResponse.json({ error: "Failed to create bill for approved invoice." }, { status: 500 });
      }

      if (isApprovalRepair) {
        const { data: repaired, error: repairReadError } = await auth.db
          .from("vendor_invoices")
          .select(VENDOR_INVOICE_SELECT)
          .eq("id", id)
          .eq("manager_user_id", auth.userId)
          .maybeSingle();
        if (repairReadError) {
          console.error("Failed to reload repaired vendor invoice", repairReadError);
          return NextResponse.json({ error: "Failed to reload approved invoice." }, { status: 500 });
        }
        if (!repaired) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
        return NextResponse.json({ invoice: mapVendorInvoiceRow(repaired) });
      }
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status,
      decided_at: now,
      decided_by: auth.userId,
      updated_at: now,
    };
    if (typeof body.decisionNote === "string") {
      patch.decision_note = body.decisionNote.trim() || null;
    }
    if (status === "paid") patch.paid_at = now;

    let updateQuery = auth.db
      .from("vendor_invoices")
      .update(patch)
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .eq("status", currentStatus);
    if (status === "scheduled" || status === "paid") {
      updateQuery = updateQuery.not("bill_id", "is", null);
    }
    const { data, error } = await updateQuery
      .select(VENDOR_INVOICE_SELECT)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) {
      return NextResponse.json(
        { error: "Invoice status changed while deciding — reload and try again." },
        { status: 409 },
      );
    }

    let responseData = data;
    if (status === "approved") {
      try {
        const bill = await createBillFromVendorInvoice(auth.db, auth.userId, id);
        responseData = { ...data, bill_id: bill.id };
      } catch (error) {
        console.error("Failed to create bill for approved vendor invoice", error);
        return NextResponse.json({ error: "Failed to create bill for approved invoice." }, { status: 500 });
      }
    }

    // Tell the vendor. Before PLAN-0915 an approval or a rejection was silent
    // on their side; only "received" and "paid" ever reached them.
    if (status === "approved" || status === "rejected") {
      await notifyVendorOfInvoiceDecision(auth.db, {
        managerUserId: auth.userId,
        vendorUserId: String(existing.vendor_user_id),
        invoiceId: id,
        workOrderId: (responseData as { work_order_id?: string | null }).work_order_id ?? null,
        totalCents: Number(existing.total_cents ?? 0),
        decision: status,
        note: typeof body.decisionNote === "string" ? body.decisionNote.trim() : "",
      }).catch(() => undefined);
    }

    const event = MANAGER_DECISIONS[status];
    if (event) {
      // Attribute the event to the vendor whose invoice moved (server-confirmed).
      track(event, existing.vendor_user_id as string, {
        invoice_id: id,
        status,
        total_cents: existing.total_cents as number,
      });
    }

    return NextResponse.json({ invoice: mapVendorInvoiceRow(responseData) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update invoice.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
