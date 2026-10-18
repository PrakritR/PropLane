import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadPlatformFinances } from "@/lib/managed-finance/finances.server";
import { financeErrorResponse, stripeOrNull } from "@/lib/managed-finance/routes.server";

export const runtime = "nodejs";

/** GET: the platform view of PropLane-held funds: cash, owed to owners and vendors, fee revenue, reconciliation. Admin only. */
export async function GET() {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  try {
    return NextResponse.json(await loadPlatformFinances(createSupabaseServiceRoleClient(), stripeOrNull()));
  } catch (e) {
    return financeErrorResponse(e, "Could not load the platform view.");
  }
}
