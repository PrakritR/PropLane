import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveManagerWorkspaceRowScope, rowInWorkspaceScope } from "@/lib/auth/co-manager-module-scope";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { resolveAppOrigin } from "@/lib/app-url";
import type { HouseholdCharge } from "@/lib/household-charges";
export const runtime = "nodejs";

/** Manager-assisted collection uses the same server prices and resident checkout as self-service. */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const body = await req.json() as { chargeId?: unknown; paymentMethod?: unknown };
    if (typeof body.chargeId !== "string" || !body.chargeId.trim()) return NextResponse.json({ error: "Choose a charge." }, { status: 400 });
    const db = createSupabaseServiceRoleClient();
    const { data: row, error } = await db.from("portal_household_charge_records").select("manager_user_id, property_id, row_data").eq("id", body.chargeId).maybeSingle();
    if (error) throw error;
    if (!row) return NextResponse.json({ error: "Charge not found." }, { status: 404 });
    const owner = String(row.manager_user_id ?? "");
    const property = row.property_id ? String(row.property_id) : null;
    const scope = await resolveManagerWorkspaceRowScope(db, user.id);
    const canCollect = owner === user.id || Boolean(property && await managerHasCoManagerPermissionForProperty(db, user.id, property, "payments", "edit"));
    if (!owner || !canCollect || !rowInWorkspaceScope(property, scope)) return NextResponse.json({ error: "Charge not found." }, { status: 404 });
    const charge = row.row_data as HouseholdCharge;
    // Resident identity comes only from the authorized persisted charge, never the request body.
    const result = await createHouseholdChargeCheckout(db, {
      userId: charge.residentUserId ?? "", userEmail: charge.residentEmail,
      chargeIds: [body.chargeId], expectedManagerUserId: owner,
      mode: "embedded", paymentMethod: body.paymentMethod === "ach" ? "ach" : "card",
      appOrigin: resolveAppOrigin(req), returnPath: "/portal/payments/incoming/pending",
    });
    return NextResponse.json(result, { status: result.ok ? 200 : result.status });
  } catch {
    return NextResponse.json({ error: "Could not start payment." }, { status: 500 });
  }
}
