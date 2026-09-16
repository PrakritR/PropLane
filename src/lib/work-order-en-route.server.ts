import "server-only";

/**
 * "On my way" — the vendor's one tap before a visit (PLAN-0915). Stamps the row
 * and tells the resident once; a second tap is a no-op. Also answered by the
 * SMS keyword OMW on the vendor line.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { workOrderEvent } from "@/lib/work-order-events.server";

export type EnRouteActor = { userId: string; email: string; fullName?: string; admin: boolean; role: string };

export async function markVendorEnRoute(
  db: SupabaseClient,
  actor: EnRouteActor,
  body: { workOrderId?: string; etaMinutes?: number },
): Promise<{ ok: true; alreadyEnRoute: boolean; workOrder: DemoManagerWorkOrderRow } | { ok: false; status: number; error: string }> {
  if (!actor.admin && actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };
  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };
  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, status: 403, error: "Forbidden." };
  if (!actor.admin && workOrder.vendor_user_id !== actor.userId) return { ok: false, status: 403, error: "Forbidden." };
  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (rowData.bucket !== "scheduled") return { ok: false, status: 400, error: "This visit is not scheduled." };
  if (rowData.enRouteAt) return { ok: true, alreadyEnRoute: true, workOrder: rowData };

  const now = new Date().toISOString();
  const eta = Number.isFinite(body.etaMinutes) ? Math.max(1, Math.min(240, Math.round(Number(body.etaMinutes)))) : undefined;
  const next: DemoManagerWorkOrderRow = { ...rowData, enRouteAt: now, ...(eta ? { enRouteEtaMinutes: eta } : {}) };
  const { data: updated, error } = await db
    .from("portal_work_order_records")
    .update({ row_data: next, updated_at: now })
    .eq("id", workOrderId)
    .is("row_data->>enRouteAt", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  // Lost the race to another tap: already en route, nothing more to send.
  if (!updated) return { ok: true, alreadyEnRoute: true, workOrder: rowData };

  const residentEmail = (rowData.residentEmail ?? "").trim();
  if (residentEmail.includes("@")) {
    await workOrderEvent(db, {
      eventId: `${workOrderId}:en_route:${now}`,
      event: "en_route",
      senderAudience: "vendor",
      managerUserId: String(workOrder.manager_user_id),
      workOrderId,
      senderUserId: actor.userId,
      senderEmail: actor.email,
      senderName: actor.fullName,
      facts: {
        reference: rowData.reference || "Work order",
        title: rowData.title || "Work order",
        propertyLabel: rowData.propertyName || undefined,
        vendorName: actor.fullName || rowData.vendorName || undefined,
        etaMinutes: eta,
      },
      recipients: [{ audience: "resident", email: residentEmail }],
    }).catch(() => undefined);
  }
  return { ok: true, alreadyEnRoute: false, workOrder: next };
}
