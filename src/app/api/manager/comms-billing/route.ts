import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadManagerCommsBillingSummary } from "@/lib/comms-billing/summary.server";
import { refreshManagerCommsPaymentMethod } from "@/lib/comms-billing/payment-method.server";
import { clearCommsBillingPause } from "@/lib/comms-billing/notifications.server";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

  const db = createSupabaseServiceRoleClient();
  await refreshManagerCommsPaymentMethod(db, auth.user.id);
  const summary = await loadManagerCommsBillingSummary(db, auth.user.id);
  return NextResponse.json(summary);
}

export async function PATCH(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

  let body: { monthlyBudgetCents?: number | null; clearBillingPause?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = createSupabaseServiceRoleClient();
  const now = new Date().toISOString();

  if (body.clearBillingPause) {
    await clearCommsBillingPause(db, auth.user.id);
  }

  if (body.monthlyBudgetCents !== undefined) {
    const budget =
      body.monthlyBudgetCents == null
        ? null
        : Math.max(0, Math.round(Number(body.monthlyBudgetCents)));
    if (budget != null && !Number.isFinite(budget)) {
      return NextResponse.json({ error: "Invalid budget" }, { status: 400 });
    }
    await db.from("manager_comms_billing_accounts").upsert(
      {
        manager_user_id: auth.user.id,
        monthly_budget_cents: budget,
        notified_budget_80_at: null,
        notified_budget_100_at: null,
        updated_at: now,
      },
      { onConflict: "manager_user_id" },
    );
  }

  const summary = await loadManagerCommsBillingSummary(db, auth.user.id);
  return NextResponse.json(summary);
}
