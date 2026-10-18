import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadVendorFinances } from "@/lib/managed-finance/finances.server";
import { financeErrorResponse, stripeOrNull } from "@/lib/managed-finance/routes.server";

export const runtime = "nodejs";

/** GET [?month=YYYY-MM]: the vendor's own balance, statement and withdrawals across PropLane-managed workspaces. */
export async function GET(req: Request) {
  const who = await resolveVendorPortalUserId();
  if (!who.ok) return NextResponse.json({ error: who.status === 401 ? "Unauthorized." : "Forbidden." }, { status: who.status });
  try {
    const view = await loadVendorFinances(createSupabaseServiceRoleClient(), stripeOrNull(), {
      vendorUserId: who.userId, month: new URL(req.url).searchParams.get("month"),
    });
    return NextResponse.json(view);
  } catch (e) {
    return financeErrorResponse(e, "Could not load your balance.");
  }
}
