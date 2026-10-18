import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { changeProplaneLine, readProplaneLine } from "@/lib/service/proplane-line.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Admin > Property management > PropLane line: the shared number on the website and its mode. Admin only on both
 * verbs (`requireAdminRoute`, re-derived here, never trusted from the page). The PATCH needs a reason and is audited
 * before it is applied (`changeProplaneLine`). Nothing here calls Twilio.
 */
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const result = await readProplaneLine(createSupabaseServiceRoleClient());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json(
    { configured: result.configured, ...result.state, lastChange: result.lastChange },
    { headers: NO_STORE },
  );
}

export async function PATCH(request: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  const result = await changeProplaneLine(createSupabaseServiceRoleClient(), admin.userId, {
    mode: body.mode,
    sharedNumber: body.sharedNumber,
    pilotWorkspaceIds: body.pilotWorkspaceIds ?? [],
    reason: body.reason,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ ok: true, ...result.state }, { headers: NO_STORE });
}
