import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { listCoordination, coordinationVendorChoices, applyCoordinationAction, type CoordinationActor } from "@/lib/vendor-coordination.server";
import { normalizePortalCoordinationInput } from "@/lib/vendor-coordination-portal-input.server";
import { coordinationRequestSchema } from "@/lib/vendor-coordination-input";
import type { CoordinationAction } from "@/lib/vendor-coordination";
export const runtime = "nodejs";
async function actor() {
  const access = await getPortalAccessContext();
  if (!access.user) throw new Error("Unauthorized.");
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(access.user.id, db)).kind === "denied") throw new Error("Forbidden.");
  const role = access.effectiveRole;
  if (role === "manager" && await refuseOwnerOnly(db, access.user.id)) throw new Error("Forbidden.");
  if (role !== "manager" && role !== "vendor" && role !== "resident") throw new Error("Forbidden.");
  if (role === "resident" && !await authorizeResidentRole(db, { userId: access.user.id, legacyRole: access.profile?.role })) throw new Error("Forbidden.");
  return { db, actor: { role, userId: access.user.id, email: String(access.profile?.email ?? access.user.email ?? "").toLowerCase() } as CoordinationActor };
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Coordination unavailable.";
  return NextResponse.json({ error: message }, { status: message === "Unauthorized." ? 401 : message === "Forbidden." ? 403 : 409 });
}
export async function GET(req: Request) {
  try { const resolved = await actor(); const id = new URL(req.url).searchParams.get("workOrderId")?.trim(); if (!id) throw new Error("Service required.");
    const [proposals, vendors] = await Promise.all([listCoordination(resolved.db, resolved.actor, id), coordinationVendorChoices(resolved.db, resolved.actor, id)]);
    return NextResponse.json({ proposals, vendors });
  } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  try { const resolved = await actor(); const parsed = coordinationRequestSchema.parse(normalizePortalCoordinationInput(await req.json()));
    const body = parsed.kind === "enroll" ? { ...parsed, actor_user_id: resolved.actor.userId, manager_user_id: resolved.actor.userId } as CoordinationAction : parsed as CoordinationAction;
    return NextResponse.json({ result: await applyCoordinationAction(resolved.db, resolved.actor, body) });
  } catch (error) { return failure(error); }
}
