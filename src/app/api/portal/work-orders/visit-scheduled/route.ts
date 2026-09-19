import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { workOrderEvent } from "@/lib/work-order-events.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

export const runtime = "nodejs";

/**
 * A visit was scheduled, rescheduled or cancelled from the manager's browser.
 * The client store owns the row; this route only puts the fact on the
 * action-event bus so resident and manager copies go through the same
 * per-event switch, template and preferences as every other message.
 * (The vendor keeps the richer calendar email the client already sends.)
 */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Work order access is unavailable for this account." }, { status: 403 });
    }
    const admin = await isAdminUser(user.id);
    const body = (await req.json().catch(() => ({}))) as {
      workOrderId?: string;
      kind?: "scheduled" | "rescheduled" | "cancelled";
      scheduledLabel?: string;
      note?: string;
    };
    const workOrderId = String(body.workOrderId ?? "").trim();
    const kind = body.kind === "rescheduled" || body.kind === "cancelled" ? body.kind : "scheduled";
    if (!workOrderId) return NextResponse.json({ error: "Work order id required." }, { status: 400 });
    const { data: workOrder } = await db
      .from("portal_work_order_records")
      .select("manager_user_id, resident_email, vendor_user_id, row_data")
      .eq("id", workOrderId)
      .maybeSingle();
    if (!workOrder || (!admin && workOrder.manager_user_id !== user.id)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { data: profile } = await db.from("profiles").select("email, full_name").eq("id", user.id).maybeSingle();
    const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
    const managerRecipients = await resolvePropertyScopedManagerRecipientIds(db, {
      ownerManagerUserId: String(workOrder.manager_user_id),
      propertyId: rowData.assignedPropertyId || rowData.propertyId || undefined,
      channel: "services",
    });
    const residentEmail = String(workOrder.resident_email ?? rowData.residentEmail ?? "").trim().toLowerCase();
    const when = String(body.scheduledLabel ?? rowData.scheduled ?? "").trim();
    await workOrderEvent(db, {
      eventId: `${workOrderId}:${kind}:${rowData.scheduledAtIso ?? when}:${kind === "cancelled" ? Date.now() : ""}`,
      event: kind,
      managerUserId: String(workOrder.manager_user_id),
      workOrderId,
      senderUserId: user.id,
      senderEmail: String(profile?.email ?? user.email ?? "").trim().toLowerCase(),
      senderName: String(profile?.full_name ?? "").trim() || undefined,
      facts: {
        reference: rowData.reference || "Work order",
        title: rowData.title || "Work order",
        propertyLabel: rowData.propertyName || undefined,
        scheduledFor: when || undefined,
        vendorName: rowData.vendorName || rowData.assignee?.name || undefined,
        note: String(body.note ?? "").trim() || undefined,
      },
      recipients: [
        ...(residentEmail.includes("@") ? [{ audience: "resident" as const, email: residentEmail }] : []),
        // The manager who scheduled it hears nothing (self-send); co-managers do.
        ...managerRecipients.filter((id) => id !== user.id).map((userId) => ({ audience: "manager" as const, userId })),
        // Vendor copies only on a change — the initial schedule already emails them with a calendar file.
        ...(kind !== "scheduled" && workOrder.vendor_user_id ? [{ audience: "vendor" as const, userId: String(workOrder.vendor_user_id) }] : []),
      ],
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not notify." }, { status: 500 });
  }
}
