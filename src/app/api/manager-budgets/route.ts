import { NextResponse } from "next/server";
import { assertManagerFinancialsCoManagerAccess } from "@/lib/auth/co-manager-access";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { listManagerBudgets, upsertManagerBudget } from "@/lib/manager-budgets.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const url = new URL(req.url);
    const fiscalYear = url.searchParams.get("fiscalYear");
    const propertyId = url.searchParams.get("propertyId")?.trim() || undefined;
    const budgets = await listManagerBudgets(auth.db, auth.userId, {
      fiscalYear: fiscalYear ? Number(fiscalYear) : undefined,
      propertyId,
    });
    return NextResponse.json({ budgets });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to list budgets." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      propertyId?: string;
      fiscalYear?: number;
      categoryCode?: string;
      monthlyAmountsCents?: Record<string, number>;
      annualCents?: number;
    };

    // Writing a budget is a financials write — this used to check only the
    // plan tier above, so the workspace's `propertyIds` list (populated by ANY
    // accepted co-manager membership, regardless of which module was granted)
    // was the only property gate. A co-manager granted a module other than
    // financials (e.g. Maintenance) on an owner's house could post a budget
    // for it. ownerManagerUserId is intentionally undefined — passing the
    // caller would short-circuit the check (owner===caller => allow) and make
    // it a no-op; undefined runs the real per-property permission check,
    // which already fast-paths true when the caller owns the property.
    const cm = await assertManagerFinancialsCoManagerAccess(auth.db, auth.userId, body.propertyId, undefined, "edit");
    if (!cm.ok) return NextResponse.json({ error: cm.error }, { status: cm.status });

    const budget = await upsertManagerBudget(auth.db, {
      managerUserId: auth.userId,
      propertyId: body.propertyId || null,
      fiscalYear: Number(body.fiscalYear) || new Date().getFullYear(),
      categoryCode: String(body.categoryCode ?? "").trim(),
      monthlyAmountsCents: body.monthlyAmountsCents ?? null,
      annualCents: body.annualCents ?? null,
    });
    track("budget_created", auth.userId, { fiscalYear: budget.fiscalYear, category: budget.categoryCode });
    return NextResponse.json({ budget });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to save budget." }, { status: 500 });
  }
}
