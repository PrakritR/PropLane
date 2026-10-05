import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import type { WorkOrderCategory } from "@/lib/reports/categories";
import { createExpensesFromWorkOrder, mergeWorkOrderCompletion } from "@/lib/work-order-expenses";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      workOrder?: DemoManagerWorkOrderRow;
      category?: WorkOrderCategory;
      vendorCostCents?: number;
      materialsCostCents?: number;
      materialsMemo?: string;
      workDoneSummary?: string;
      /** When true, the client sends the resident notice (editable email + SMS). */
      skipResidentNotify?: boolean;
    };

    const workOrder = body.workOrder;
    if (!workOrder?.id) return NextResponse.json({ error: "workOrder required." }, { status: 400 });
    if (!body.category) return NextResponse.json({ error: "category required." }, { status: 400 });

    // Ownership gate — the SAME shape as `approveAndPayWorkOrder`
    // (src/lib/work-order-approve-pay.server.ts). Without it this read had no
    // owner filter while the upsert below wrote `manager_user_id: auth.userId`,
    // so any manager could overwrite AND re-own another manager's work order by
    // id: it left the victim's portal and appeared in the attacker's with
    // attacker-chosen title, costs and resident. Ids are legitimately visible to
    // residents, vendors and co-managers, so they are not a secret.
    const { data: existing } = await auth.db
      .from("portal_work_order_records")
      .select("manager_user_id, row_data")
      .eq("id", workOrder.id)
      .maybeSingle();
    if (existing && auth.role !== "admin" && existing.manager_user_id !== auth.userId) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    // Preserve the stored owner rather than stamping the caller; only a genuinely
    // new row (no existing record) is owned by whoever creates it.
    const ownerManagerUserId = String(existing?.manager_user_id ?? auth.userId);
    const existingRow = (existing?.row_data ?? {}) as DemoManagerWorkOrderRow;
    const alreadyCompleted = Boolean(existingRow.completedAt);

    // The booked cost is the accepted bid's, read here exactly as approve-and-pay reads it. A client-sent figure
    // only stands in when no bid was accepted (a directly-assigned job); it never outranks one.
    const { data: acceptedBids, error: bidError } = await auth.db
      .from("work_order_bids")
      .select("amount_cents, materials_cents, vendor_directory_id")
      .eq("work_order_id", workOrder.id)
      .eq("status", "accepted");
    if (bidError) return NextResponse.json({ error: "Could not read the accepted bid." }, { status: 500 });
    if ((acceptedBids ?? []).length > 1) {
      return NextResponse.json({ error: "This job has more than one accepted bid. Resolve it before completing." }, { status: 409 });
    }
    const acceptedBid = acceptedBids?.[0] as
      | { amount_cents?: number | null; materials_cents?: number | null; vendor_directory_id?: string | null }
      | undefined;
    const bidVendorCostCents = acceptedBid?.amount_cents == null ? NaN : Number(acceptedBid.amount_cents);
    const bidMaterialsCostCents = acceptedBid?.materials_cents == null ? NaN : Number(acceptedBid.materials_cents);
    const vendorCostCents = Number.isFinite(bidVendorCostCents) ? bidVendorCostCents : body.vendorCostCents;
    const materialsCostCents = Number.isFinite(bidMaterialsCostCents) ? bidMaterialsCostCents : body.materialsCostCents;
    const vendorId =
      typeof acceptedBid?.vendor_directory_id === "string" && acceptedBid.vendor_directory_id.trim()
        ? acceptedBid.vendor_directory_id
        : workOrder.vendorId;

    // The stored owner, not the caller: an admin completing a manager's job must not land the
    // expense in their own ledger, and the idempotence guard filters on the same owner the
    // approve + pay path posts under.
    const expenseEntryIds = await createExpensesFromWorkOrder(auth.db, ownerManagerUserId, {
      workOrderId: workOrder.id,
      category: body.category,
      vendorCostCents,
      materialsCostCents,
      materialsMemo: body.materialsMemo,
      workDoneSummary: body.workDoneSummary,
      propertyId: workOrder.propertyId || workOrder.assignedPropertyId,
      vendorId,
    });

    const updated = mergeWorkOrderCompletion(
      workOrder,
      {
        workOrderId: workOrder.id,
        category: body.category,
        vendorCostCents,
        materialsCostCents,
        materialsMemo: body.materialsMemo,
        workDoneSummary: body.workDoneSummary,
        propertyId: workOrder.propertyId,
        vendorId,
      },
      expenseEntryIds,
    );

    const { error } = await auth.db.from("portal_work_order_records").upsert(
      {
        id: workOrder.id,
        manager_user_id: ownerManagerUserId,
        property_id: workOrder.propertyId ?? null,
        resident_email: workOrder.residentEmail ?? null,
        row_data: updated,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (!alreadyCompleted && !body.skipResidentNotify) {
      const propertyLabel = updated.propertyName ? `${updated.propertyName}${updated.unit ? ` · ${updated.unit}` : ""}` : "";
      const title = updated.title || "Work order";
      const residentEmail = (updated.residentEmail ?? "").trim();
      if (residentEmail.includes("@")) {
        await deliverPortalInboxMessage(auth.db, {
          senderUserId: auth.userId,
          senderEmail: auth.email,
          fromName: "PropLane Portal",
          subject: `${title} completed`,
          text: `Your work order "${title}"${propertyLabel ? ` at ${propertyLabel}` : ""} has been completed.`,
          toEmails: [residentEmail],
          deliverToPortalInbox: true,
          deliverViaEmail: false,
          deliverViaSms: false,
        }).catch(() => undefined);
        track("work_order_resident_notified", auth.userId, { stage: "completed", work_order_id: workOrder.id });
      }
    }

    track("work_order_completed", auth.userId, { work_order_id: workOrder.id, property_id: workOrder.propertyId ?? "", category: body.category ?? "" });
    return NextResponse.json({ ok: true, workOrder: updated, expenseEntryIds });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
