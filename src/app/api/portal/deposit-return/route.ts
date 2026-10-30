import { NextResponse } from "next/server";
import { resolveManagerWorkspaceRowScope, rowInWorkspaceScope } from "@/lib/auth/co-manager-module-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/** Refuse provider returns until reservation and trust settlement are atomic. */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    // Deposits are real provider-backed funds. A durable test identity never
    // reaches charge/ledger reads or Stripe, regardless of workspace state.
    if ((await resolveTestWorkspaceClassification(user.id, db)).kind !== "normal") {
      return NextResponse.json({ error: "This action is unavailable." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const chargeId = typeof body.chargeId === "string" ? body.chargeId.trim() : "";
    if (!chargeId) return NextResponse.json({ error: "chargeId is required." }, { status: 400 });

    const rawAmount = body.amountCents;
    if (rawAmount !== undefined && (typeof rawAmount !== "number" || !Number.isFinite(rawAmount))) {
      // A malformed amount is refused rather than dropped: silently returning the FULL deposit
      // because a number failed to parse is the worst possible reading of a bad request.
      return NextResponse.json({ error: "amountCents must be a number." }, { status: 400 });
    }

    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, property_id, status, row_data")
      .eq("id", chargeId)
      .maybeSingle();

    // A missing charge and someone else's charge answer identically, so this is not an oracle for
    // which charge ids exist.
    if (!row || String(row.manager_user_id ?? "") !== user.id) {
      return NextResponse.json({ error: "Deposit not found." }, { status: 404 });
    }

    // The charge reaches its house directly through its own `property_id`
    // column (the same column `portal-household-charges` scopes by), so no
    // join is needed here — only a single-row read of the column already on
    // this table. The active workspace still narrows: a manager's own
    // deposit outside it is refused exactly as if the charge were absent,
    // same 404 as above so this stays a non-oracle.
    const workspaceScope = await resolveManagerWorkspaceRowScope(db, user.id);
    if (!rowInWorkspaceScope(row.property_id ? String(row.property_id) : null, workspaceScope)) {
      return NextResponse.json({ error: "Deposit not found." }, { status: 404 });
    }

    // Provider-backed deposit returns require an atomic reservation and linked
    // trust settlement. Until those are available, do not send money.
    return NextResponse.json({
      error: "Deposit returns are unavailable while accounting is being reconciled.",
      status: "unavailable",
    }, { status: 503 });
  } catch {
    return NextResponse.json({ error: "Could not return the deposit." }, { status: 500 });
  }
}
