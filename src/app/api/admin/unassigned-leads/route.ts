import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { listOpenLeads } from "@/lib/one-number/unassigned-leads.server";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * GET: the platform "Unassigned leads" queue. Admin only; a manager never reaches it. Phones are masked to the
 * last four digits here, so the browser never holds a prospect's number. `?houses=1` adds the live public
 * houses the Assign popup offers.
 */
export async function GET(request: Request) {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const params = new URL(request.url).searchParams;
  const db = createSupabaseServiceRoleClient();
  const queue = await listOpenLeads(db, {
    limit: Number(params.get("pageSize")) || 50,
    offset: ((Number(params.get("page")) || 1) - 1) * (Number(params.get("pageSize")) || 50),
  });
  let houses: { id: string; label: string }[] | undefined;
  if (params.get("houses") === "1") {
    const listings = await getCrawlPublicListings().catch(() => []);
    houses = listings.map((p) => ({ id: p.id, label: [p.buildingName || p.title, p.address].filter(Boolean).join(" - ") })).filter((h) => h.id && h.label);
  }
  return NextResponse.json({ ...queue, ...(houses ? { houses } : {}) });
}
