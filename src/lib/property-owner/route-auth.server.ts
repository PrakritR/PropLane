import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOwnerGrants, narrowGrantsToWorkspace, type OwnerGrant } from "@/lib/property-owner/access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export type OwnerRouteContext = { db: SupabaseClient; userId: string; grants: OwnerGrant[] };

/**
 * The one gate every `/api/owner/*` route goes through.
 *
 * The user id comes from the session, the houses and the manager from the
 * owner membership (`loadOwnerGrants`). Nothing in a request names an owner, a
 * manager or an authorization. An account with no owner membership gets 403,
 * which is also what a revoked owner gets on their very next request: the
 * membership is read fresh on every call.
 */
export async function requireOwnerRoute(req?: Request): Promise<OwnerRouteContext | NextResponse> {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  let grants: OwnerGrant[];
  try {
    grants = await loadOwnerGrants(db, user.id);
  } catch {
    return NextResponse.json({ error: "Could not load your properties." }, { status: 500 });
  }
  if (grants.every((g) => g.houses.length === 0)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  // The workspace switcher narrows every read to ONE of the owner's own workspaces. A key that is none of theirs is a 404,
  // indistinguishable from one that does not exist; no key means every workspace.
  const workspace = req ? (new URL(req.url).searchParams.get("workspace") ?? "").trim() : "";
  if (workspace) {
    const narrowed = narrowGrantsToWorkspace(grants, workspace);
    if (narrowed.length === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    grants = narrowed;
  }
  return { db, userId: user.id, grants };
}

/**
 * The opt-out a MANAGER route takes directly. It used to return 403 for an owner-only account (a Property owner who
 * held the manager role row only to host `/portal/owner`). That portal is retired: an owner uses the Property portal,
 * view-only on a PropLane-managed workspace (the middleware and tool layer refuse the writes), so there is nothing to
 * refuse here. Always `null` ("continue"); kept as the one seam the manager routes already call.
 * `tests/unit/owner-only-manager-routes.test.ts` pins that each route still asks.
 */
export async function refuseOwnerOnly(_db: SupabaseClient, _userId: string): Promise<NextResponse | null> {
  return null;
}
