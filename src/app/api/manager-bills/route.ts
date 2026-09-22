import { NextResponse } from "next/server";
import { assertManagerFinancialsCoManagerAccess } from "@/lib/auth/co-manager-access";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { mapManagerBillRow, MANAGER_BILL_SELECT } from "@/lib/manager-bills";
import { createManagerBill } from "@/lib/manager-bills.server";
import { track } from "@/lib/analytics/posthog";
import { applyWorkspaceRowScope, resolveActiveWorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const status = new URL(req.url).searchParams.get("status")?.trim();
    // The list follows the same active-workspace rule the bill writes already
    // use (`manager-bills.server.ts`): a bill tied to a house outside the
    // active workspace is another workspace's payable, and an account-level
    // bill (no property) belongs to the viewer's own default workspace.
    const wsScope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    let query = applyWorkspaceRowScope(
      auth.db
        .from("manager_bills")
        .select(MANAGER_BILL_SELECT)
        .eq("manager_user_id", auth.userId)
        .order("created_at", { ascending: false })
        .limit(200),
      wsScope,
    );
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ bills: (data ?? []).map((r) => mapManagerBillRow(r as Record<string, unknown>)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list bills.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      description?: string;
      amountCents?: number;
      dueDate?: string;
      vendorId?: string;
      workOrderId?: string;
      propertyId?: string;
      categoryCode?: string;
    };

    // Creating/updating bills is a write — requires the "edit" level on financials.
    // ownerManagerUserId is intentionally undefined: passing the caller would
    // short-circuit the check (owner===caller => allow) and make the gate a
    // no-op. Undefined runs the real per-property permission check, which
    // already fast-paths true when the caller owns the property.
    const cm = await assertManagerFinancialsCoManagerAccess(auth.db, auth.userId, body.propertyId, undefined, "edit");
    if (!cm.ok) return NextResponse.json({ error: cm.error }, { status: cm.status });

    const bill = await createManagerBill(auth.db, {
      managerUserId: auth.userId,
      description: body.description?.trim() || "Bill",
      amountCents: Math.round(Number(body.amountCents) || 0),
      dueDate: body.dueDate,
      vendorId: body.vendorId,
      workOrderId: body.workOrderId,
      propertyId: body.propertyId,
      categoryCode: body.categoryCode,
    });

    track("bill_created", auth.userId, { billId: bill.id, amountCents: bill.amountCents });
    return NextResponse.json({ bill });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create bill.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
