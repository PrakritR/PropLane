import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { listVendorLeads } from "@/lib/one-number/onboarding/vendor-intake.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** GET: new vendors who texted PropLane and finished intake, waiting for review. Admin only; phones masked. */
export async function GET() {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const items = await listVendorLeads(createSupabaseServiceRoleClient());
  return NextResponse.json({ items });
}
