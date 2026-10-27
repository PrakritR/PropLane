import { NextResponse } from "next/server";
import { resendAdminInvite } from "@/lib/admin-team/admin-team-invite.server";
import { NO_STORE, failureResponse, readJsonBody, requireAdminTeamActor } from "@/lib/admin-team/admin-team-route.server";

export const runtime = "nodejs";

/** Resend a waiting admin invite: the old link is turned off and a fresh one is emailed for the same grant. */
export async function POST(request: Request) {
  const gate = await requireAdminTeamActor();
  if (!gate.ok) return gate.response;
  const body = await readJsonBody(request);
  if (!body || typeof body.inviteId !== "string") return NextResponse.json({ error: "Choose an invite." }, { status: 400, headers: NO_STORE });
  const result = await resendAdminInvite(gate.db, gate.userId, gate.actor, body.inviteId);
  if (!result.ok) return failureResponse(result);
  return NextResponse.json({ ok: true, inviteId: result.inviteId }, { headers: NO_STORE });
}
