import "server-only";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAdminTeamActor } from "@/lib/admin-team/admin-team.server";
import type { AdminTeamActor } from "@/lib/admin-team/admin-team-model";
import type { SupabaseClient } from "@supabase/supabase-js";

export const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The Admin team routes' gate. It is NOT `requireAdminRoute()`: a workspace admin (a PropLane-issued seat that carries
 * member rights) manages their own workspaces' seats here, so the route admits them and the verbs decide, per target:
 * anything about an Overall admin, or any workspace outside the caller's reach, is refused by the verb itself. A caller
 * who is neither an Overall admin nor a seat holder with member rights is 403; signed out is 401. Every PropLane-wide
 * `/api/admin/*` route keeps `requireAdminRoute()`, so a seat holder gets 403 there.
 */
export async function requireAdminTeamActor(): Promise<
  { ok: true; userId: string; actor: AdminTeamActor; db: SupabaseClient } | { ok: false; response: NextResponse }
> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE }) };
  const db = createSupabaseServiceRoleClient();
  let actor: AdminTeamActor;
  try {
    actor = await resolveAdminTeamActor(db, user.id);
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Could not verify your access. Please retry." }, { status: 503, headers: NO_STORE }) };
  }
  if (!actor.overall && actor.manageableWorkspaceIds.size === 0) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE }) };
  }
  return { ok: true, userId: user.id, actor, db };
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function failureResponse(result: { status: number; error: string }) {
  return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
}
