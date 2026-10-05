import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import type { WorkOrderCategory } from "@/lib/reports/categories";

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
    if (!existing) return NextResponse.json({ error: "Service not found." }, { status: 404 });
    if (auth.role !== "admin" && existing.manager_user_id !== auth.userId) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const ownerManagerUserId = String(existing.manager_user_id);
    const existingRow = (existing.row_data ?? {}) as DemoManagerWorkOrderRow;
    const alreadyCompleted = Boolean(existingRow.completedAt);

    // Completion records the service's work. A cash expense is booked only
    // when a verified payment settles (or a separately authorized manual pay).
    const expenseEntryIds: string[] = [];

    // The database locks the current service row and merges only completion
    // facts. It cannot replace payment claims or owner/resident identity from
    // a stale client snapshot while Stripe or balance settlement is pending.
    const { data: updatedRaw, error } = await auth.db.rpc("complete_work_order_record", {
      p_work_order: workOrder.id,
      p_manager: ownerManagerUserId,
      p_patch: {
        category: body.category,
        vendorCostCents: body.vendorCostCents,
        materialsCostCents: body.materialsCostCents,
        materialsMemo: body.materialsMemo,
        workDoneSummary: body.workDoneSummary,
      },
    });
    if (error || !updatedRaw) return NextResponse.json({ error: error?.message ?? "Could not complete service." }, { status: 409 });
    const updated = updatedRaw as DemoManagerWorkOrderRow;

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

    track("work_order_completed", auth.userId, { work_order_id: workOrder.id, property_id: updated.propertyId ?? "", category: body.category ?? "" });
    return NextResponse.json({ ok: true, workOrder: updated, expenseEntryIds });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
