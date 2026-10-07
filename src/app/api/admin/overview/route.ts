import { NextResponse } from "next/server";
import { loadAdminOverview } from "@/lib/admin/admin-overview.server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * GET /api/admin/overview — the admin Dashboard's server aggregate.
 * Admin-only (401 signed out, 403 for anyone without the admin role); reads
 * through the service-role client. Sandbox/demo accounts are excluded.
 */
export async function GET() {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    const overview = await loadAdminOverview(createSupabaseServiceRoleClient());
    return NextResponse.json(overview, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
