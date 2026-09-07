import { NextResponse } from "next/server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import type { WorkOrderCategory } from "@/lib/reports/categories";
import { approveAndPayWorkOrder, findBlockingVendorPayout } from "@/lib/work-order-approve-pay.server";

export const runtime = "nodejs";

/**
 * Pre-check for the confirm step: does this work order already have a PropLane
 * payout that a second mark-paid would duplicate? Read-only; the POST enforces
 * the same rule regardless of whether the client asked first.
 */
export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const workOrderId = new URL(req.url).searchParams.get("workOrderId")?.trim() ?? "";
    if (!workOrderId) return NextResponse.json({ error: "workOrderId required." }, { status: 400 });

    const { data: existing } = await auth.db
      .from("portal_work_order_records")
      .select("manager_user_id")
      .eq("id", workOrderId)
      .maybeSingle();
    if (!existing || (auth.role !== "admin" && existing.manager_user_id !== auth.userId)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const blocking = await findBlockingVendorPayout(auth.db, workOrderId);
    if (!blocking.ok) return NextResponse.json({ error: blocking.error }, { status: 500 });
    return NextResponse.json({ existingPayout: blocking.payout });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Manager's one-tap (or confirm-preview, for larger amounts — gated client-side) "Approve
 * + Pay": delegates to approveAndPayWorkOrder (work-order-approve-pay.server.ts) — the same
 * completion + expense-logging + markWorkOrderPaid + best-effort Stripe payout +
 * notifications implementation the agent tool layer uses.
 *
 * A work order that already has a `pending` / `paid` vendor payout answers 409 with
 * `code: "existing_payout"` and the payout itself unless the body carries
 * `acknowledgeExistingPayout: true` — the client warning is not the guard, this is. */
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
      paymentChannel?: "ach" | "zelle" | "venmo";
      acknowledgeExistingPayout?: unknown;
    };

    const result = await approveAndPayWorkOrder(
      auth.db,
      { userId: auth.userId, email: auth.email, isAdmin: auth.role === "admin" },
      { ...body, acknowledgeExistingPayout: body.acknowledgeExistingPayout === true },
    );
    if (!result.ok) {
      if ("existingPayout" in result) {
        return NextResponse.json(
          { error: result.error, code: result.code, existingPayout: result.existingPayout },
          { status: result.status },
        );
      }
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, workOrder: result.workOrder, expenseEntryIds: result.expenseEntryIds });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
