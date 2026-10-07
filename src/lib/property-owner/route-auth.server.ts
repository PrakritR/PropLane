import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOwnerGrants, ownerAccessStateFor, type OwnerGrant } from "@/lib/property-owner/access.server";
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
export async function requireOwnerRoute(): Promise<OwnerRouteContext | NextResponse> {
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
  return { db, userId: user.id, grants };
}

/**
 * The opt-out every MANAGER route takes: an owner-only account holds the
 * manager role row only to host `/portal/owner`, so it gets 403 from any
 * manager-surface handler. Returns the 403 response, or null to continue.
 * `tests/unit/owner-only-manager-routes.test.ts` fails a manager route that
 * neither calls this nor is listed there as consciously exempt.
 */
export async function refuseOwnerOnly(db: SupabaseClient, userId: string): Promise<NextResponse | null> {
  if ((await ownerAccessStateFor(db, userId)).ownerOnly) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return null;
}
