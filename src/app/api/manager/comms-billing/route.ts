import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadManagerCommsBillingSummary } from "@/lib/comms-billing/summary.server";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  try {
    const summary = await loadManagerCommsBillingSummary(db, auth.userId);
    return NextResponse.json(summary, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "We couldn’t load your communication balance. Try again." }, { status: 503 });
  }
}

export async function PATCH(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let body: { monthlyBudgetCents?: number | null; clearBillingPause?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["monthlyBudgetCents", "clearBillingPause"].includes(key))) return NextResponse.json({ error: "Invalid settings." }, { status: 400 });
  const db = createSupabaseServiceRoleClient();
  const now = new Date().toISOString();

  if (body.clearBillingPause) {
    return NextResponse.json({ error: "Contact PropLane to review a billing pause." }, { status: 403 });
  }

  if (body.monthlyBudgetCents !== undefined) {
    const budget = body.monthlyBudgetCents;
    if (budget !== null && (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 0 || budget > 1_000_000)) {
      return NextResponse.json({ error: "Enter a budget from $0 to $10,000." }, { status: 400 });
    }
    const { error } = await db.from("manager_comms_billing_accounts").upsert(
      {
        manager_user_id: auth.userId,
        monthly_budget_cents: budget,
        notified_budget_80_at: null,
        notified_budget_100_at: null,
        updated_at: now,
      },
      { onConflict: "manager_user_id" },
    );
    if (error) return NextResponse.json({ error: "Could not save budget alerts." }, { status: 503 });
  }

  try {
    const summary = await loadManagerCommsBillingSummary(db, auth.userId);
    return NextResponse.json(summary, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "We couldn’t load your communication balance. Try again." }, { status: 503 });
  }
}
