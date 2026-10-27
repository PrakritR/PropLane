import { NextResponse } from "next/server";
import { inviteAdminTeamMember } from "@/lib/admin-team/admin-team-invite.server";
import { NO_STORE, failureResponse, readJsonBody, requireAdminTeamActor } from "@/lib/admin-team/admin-team-route.server";
import type { InviteAccessInput } from "@/lib/co-manager-invite-grant";

export const runtime = "nodejs";

/**
 * Invite to the admin team. Role, workspaces and access are requests: the verb re-derives whether this caller may make
 * the grant (Overall admin for Overall admin; their own workspaces, never above their own role, for the rest).
 */
export async function POST(request: Request) {
  const gate = await requireAdminTeamActor();
  if (!gate.ok) return gate.response;
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  const result = await inviteAdminTeamMember(gate.db, gate.userId, gate.actor, {
    email: body.email,
    role: body.role,
    workspaceIds: body.workspaceIds,
    access: (body.access && typeof body.access === "object" ? body.access : {}) as InviteAccessInput,
  });
  if (!result.ok) return failureResponse(result);
  return NextResponse.json({ ok: true, inviteId: result.inviteId }, { status: 201, headers: NO_STORE });
}
