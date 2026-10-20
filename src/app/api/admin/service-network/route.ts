import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { listFreeManagers } from "@/lib/service/service-network.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * GET /api/admin/service-network - Admin > Service > Network: the free-tier managers (newest first). Admin only; the
 * vendor leads have their own reader (`/api/admin/vendor-leads`) and the roster is `/api/admin/service-vendors`.
 */
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  try {
    const managers = await listFreeManagers(createSupabaseServiceRoleClient());
    return NextResponse.json({ managers }, { headers: NO_STORE });
  } catch (error) {
    console.error("GET /api/admin/service-network failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Could not load the free managers." }, { status: 503, headers: NO_STORE });
  }
}
