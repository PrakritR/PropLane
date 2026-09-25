import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadDirectoryListedVendors } from "@/lib/vendor-directory.server";

export const runtime = "nodejs";

/** Directory-listed self-serve vendors, public-safe fields only — merged into the manager "PropLane vendors" tab. */
export async function GET(req: Request) {
  try {
    const ctx = await getPortalAccessContext();
    if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    // `profiles.role` is legacy and singular — a multi-role account (manager +
    // resident, say) must not be refused because that column happens to say
    // something else. `hasRole` reads `profile_roles` (AGENTS.md § "profiles.role
    // is legacy"); `user_metadata.role` is client-writable and was never an
    // authorization source.
    if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const db = createSupabaseServiceRoleClient();
    const url = new URL(req.url);
    const rows = await loadDirectoryListedVendors(db, {
      trade: url.searchParams.get("trade") ?? undefined,
      area: url.searchParams.get("area") ?? undefined,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load vendor directory.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
