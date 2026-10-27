import { NextResponse } from "next/server";
import { removeAdminTeamMember } from "@/lib/admin-team/admin-team.server";
import { NO_STORE, failureResponse, readJsonBody, requireAdminTeamActor } from "@/lib/admin-team/admin-team-route.server";

export const runtime = "nodejs";

/** Remove a person from the admin team (or turn off a waiting invite). The last Overall admin cannot be removed. */
export async function POST(request: Request) {
  const gate = await requireAdminTeamActor();
  if (!gate.ok) return gate.response;
  const body = await readJsonBody(request);
  const userId = typeof body?.userId === "string" ? body.userId : undefined;
  const inviteId = typeof body?.inviteId === "string" ? body.inviteId : undefined;
  if (!body || (!userId && !inviteId)) return NextResponse.json({ error: "Choose a teammate." }, { status: 400, headers: NO_STORE });
  const result = await removeAdminTeamMember(gate.db, gate.userId, gate.actor, { userId, inviteId });
  if (!result.ok) return failureResponse(result);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
