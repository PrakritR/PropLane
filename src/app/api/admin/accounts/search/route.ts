import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import type { AdminAccountKind } from "@/lib/admin/admin-accounts.server";
import { searchAdminAccounts } from "@/lib/admin/admin-accounts-search.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function kindFromParam(raw: string | null): AdminAccountKind {
  return raw === "resident" || raw === "vendor" ? raw : "manager";
}

/**
 * GET /api/admin/accounts/search?kind=manager|resident|vendor&q=…
 * Matches name, email, phone or PropLane ID. Admin-only, service-role reads.
 */
export async function GET(req: Request) {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    const url = new URL(req.url);
    const query = (url.searchParams.get("q") ?? "").slice(0, 120);
    const result = await searchAdminAccounts(createSupabaseServiceRoleClient(), {
      kind: kindFromParam(url.searchParams.get("kind")),
      query,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    // A Supabase / PostgREST message names schema and query shape: logged, never returned.
    console.error("GET /api/admin/accounts/search failed", e);
    return NextResponse.json({ error: "Could not search accounts." }, { status: 500 });
  }
}
