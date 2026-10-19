import { NextResponse } from "next/server";
import type { AuthRole } from "@/components/auth/portal-switcher";
import { getPortalAccessContext, reachablePortalRoles } from "@/lib/auth/portal-access";
import { ownerAccessStateFor } from "@/lib/property-owner/access.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await getPortalAccessContext();
    if (!ctx.user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    // `roles` = membership (what the account holds — use for add-portal filtering).
    // `reachableRoles` = portals the account may enter right now (chooser / switcher).
    const reachable = reachablePortalRoles(ctx) as AuthRole[];
    // An owner-only account (a Property owner, e.g. the owner of record of a PropLane Service workspace) holds the
    // `manager` role only as the host of the owner portal; the chooser names that entry "Owner". A read that
    // fails changes nothing: the entry keeps its Property label.
    const ownerOnly = reachable.includes("manager")
      ? await ownerAccessStateFor(createSupabaseServiceRoleClient(), ctx.user.id)
          .then((state) => state.ownerOnly)
          .catch(() => false)
      : false;
    return NextResponse.json({
      ownerOnly,
      roles: ctx.roles as AuthRole[],
      reachableRoles: reachable,
      effectiveRole: ctx.effectiveRole,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
