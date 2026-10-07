import { NextResponse } from "next/server";
import { loadAdminHealth } from "@/lib/admin/admin-health.server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** GET /api/admin/health — failed deliveries and stuck work, grouped by kind. Admin-only. */
export async function GET() {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    const health = await loadAdminHealth(createSupabaseServiceRoleClient());
    return NextResponse.json(health, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
