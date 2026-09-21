import { NextResponse } from "next/server";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { loadManagerVendorSummary } from "@/lib/manager-vendor-summary.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ vendorId: string }> }) {
  const access = await getPortalAccessContext();
  if (!access.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!hasRole(access, "manager")) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const { vendorId } = await context.params;
  const result = await loadManagerVendorSummary(createSupabaseServiceRoleClient(), access.user.id, vendorId);
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "Not found." : "Forbidden." }, { status: result.status });
  return NextResponse.json(result.summary);
}
