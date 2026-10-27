import { NextResponse } from "next/server";
import { listAdminTeam } from "@/lib/admin-team/admin-team.server";
import { NO_STORE, failureResponse, requireAdminTeamActor } from "@/lib/admin-team/admin-team-route.server";

export const runtime = "nodejs";

/** Admin team list. Overall admins see everyone; a workspace admin sees only the seats of workspaces they manage. */
export async function GET() {
  const gate = await requireAdminTeamActor();
  if (!gate.ok) return gate.response;
  const result = await listAdminTeam(gate.db, gate.userId, gate.actor);
  if (!result.ok) return failureResponse(result);
  return NextResponse.json(result.payload, { headers: NO_STORE });
}
