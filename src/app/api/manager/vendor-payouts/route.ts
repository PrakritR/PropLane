import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { resolveManagerWorkspaceRowScope, rowInWorkspaceScope } from "@/lib/auth/co-manager-module-scope";

export const runtime = "nodejs";

/**
 * N004: a read-only manager-side aggregate payout report — every
 * `vendor_payouts` row across this manager's own vendors, with the vendor
 * name and the work order/service reference resolved server-side. No writes;
 * `vendor_payouts` itself is written only by `payoutVendorForWorkOrder`
 * (approve-pay). `vendor_payouts` has no fee column today, so `feeCents` is
 * always null here rather than fabricated — the UI shows "—" for it and this
 * is called out as a follow-up in the ws5 report.
 */
export type ManagerVendorPayoutReportRow = {
  id: string;
  vendorUserId: string;
  vendorName: string;
  workOrderId: string;
  workOrderReference: string | null;
  amountCents: number;
  feeCents: null;
  status: "pending" | "paid" | "failed" | "skipped";
  createdAt: string;
};

export async function GET() {
  try {
    const ctx = await getPortalAccessContext();
    if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const db = createSupabaseServiceRoleClient();
    const managerUserId = ctx.user.id;

    const { data: payouts, error } = await db
      .from("vendor_payouts")
      .select("id, vendor_user_id, work_order_id, amount_cents, status, created_at")
      .eq("manager_user_id", managerUserId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let rows = (payouts ?? []) as {
      id: string;
      vendor_user_id: string;
      work_order_id: string;
      amount_cents: number;
      status: string;
      created_at: string;
    }[];

    // The payout report belongs to the ACTIVE workspace: a payout is placed by the house its
    // work order names, never by the paying manager alone (one account can own several
    // workspaces). A payout whose work order cannot be placed is left out while narrowed.
    const workspaceScope = await resolveManagerWorkspaceRowScope(db, managerUserId);
    const workOrderIds = [...new Set(rows.map((r) => r.work_order_id).filter(Boolean))];
    const referenceByWorkOrderId = new Map<string, string | null>();
    const workOrderInScope = new Map<string, boolean>();
    if (workOrderIds.length > 0) {
      const { data: woRows, error: woError } = await db
        .from("portal_work_order_records")
        .select("id, property_id, assigned_property_id, row_data")
        .in("id", workOrderIds);
      if (woError) return NextResponse.json({ error: woError.message }, { status: 500 });
      for (const r of (woRows ?? []) as {
        id: string;
        property_id: string | null;
        assigned_property_id: string | null;
        row_data: unknown;
      }[]) {
        const rowData = r.row_data as { reference?: string; title?: string } | null;
        referenceByWorkOrderId.set(r.id, rowData?.reference || rowData?.title || null);
        const named = [r.property_id, r.assigned_property_id].map((id) => (id ?? "").trim()).filter(Boolean);
        workOrderInScope.set(
          r.id,
          named.length === 0
            ? rowInWorkspaceScope(null, workspaceScope)
            : named.some((id) => rowInWorkspaceScope(id, workspaceScope)),
        );
      }
    }
    if (workspaceScope.propertyIds !== null) {
      rows = rows.filter((r) => workOrderInScope.get(r.work_order_id) === true);
    }

    const vendorUserIds = [...new Set(rows.map((r) => r.vendor_user_id).filter(Boolean))];
    const vendorNameByUserId = new Map<string, string>();
    if (vendorUserIds.length > 0) {
      const { data: vendorRows } = await db
        .from("manager_vendor_records")
        .select("vendor_user_id, row_data")
        .eq("manager_user_id", managerUserId)
        .in("vendor_user_id", vendorUserIds);
      for (const r of (vendorRows ?? []) as { vendor_user_id: string | null; row_data: unknown }[]) {
        if (!r.vendor_user_id) continue;
        const name = (r.row_data as ManagerVendorRow | null)?.name;
        if (name) vendorNameByUserId.set(r.vendor_user_id, name);
      }
    }

    const report: ManagerVendorPayoutReportRow[] = rows.map((r) => ({
      id: r.id,
      vendorUserId: r.vendor_user_id,
      vendorName: vendorNameByUserId.get(r.vendor_user_id) ?? "Vendor",
      workOrderId: r.work_order_id,
      workOrderReference: referenceByWorkOrderId.get(r.work_order_id) ?? null,
      amountCents: r.amount_cents,
      feeCents: null,
      status: (r.status as ManagerVendorPayoutReportRow["status"]) ?? "pending",
      createdAt: r.created_at,
    }));

    return NextResponse.json({ rows: report });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load payout report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
