import { NextResponse } from "next/server";
import { changeAdminTeamMember } from "@/lib/admin-team/admin-team.server";
import { parseAdminTeamRole } from "@/lib/admin-team/admin-team-model";
import { NO_STORE, failureResponse, readJsonBody, requireAdminTeamActor } from "@/lib/admin-team/admin-team-route.server";

export const runtime = "nodejs";

/** Change a person's role, workspaces, houses and access. Overall-admin changes are Overall-admin only (the verb checks). */
export async function POST(request: Request) {
  const gate = await requireAdminTeamActor();
  if (!gate.ok) return gate.response;
  const body = await readJsonBody(request);
  const role = parseAdminTeamRole(body?.role);
  if (!body || !role || typeof body.userId !== "string") {
    return NextResponse.json({ error: "Choose a teammate and a role." }, { status: 400, headers: NO_STORE });
  }
  const result = await changeAdminTeamMember(gate.db, gate.userId, gate.actor, {
    userId: body.userId,
    role,
    workspaceIds: Array.isArray(body.workspaceIds) ? [...new Set(body.workspaceIds.map((id) => String(id ?? "").trim()).filter(Boolean))] : [],
    access: body.access && typeof body.access === "object" && !Array.isArray(body.access) ? (body.access as Record<string, unknown>) : {},
  });
  if (!result.ok) return failureResponse(result);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
