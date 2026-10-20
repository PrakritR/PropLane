import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import {
  addServiceTeamMember,
  attachWorkspaceToService,
  authorizeOpenServiceWorkspace,
  createServiceWorkspace,
  inviteServiceClient,
  listServiceAttachCandidates,
  listServiceTeam,
  listServiceWorkspaces,
  removeServiceTeamMember,
  renameServiceWorkspace,
  setServiceOwnerOfRecord,
  setServiceWorkspaceFee,
  type ServiceFailure,
} from "@/lib/service/service-workspaces.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };
/** Where "Open" lands: the manager property portal, scoped to the workspace by the switcher cookie. */
const SERVICE_OPEN_HREF = "/portal/properties";

function failure(result: ServiceFailure) {
  return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
}

/**
 * Admin > Service. Every verb starts with `requireAdminRoute()` (401 signed out, 403 not an admin) and
 * the service layer then re-derives the service owner, that the workspace carries the service flag, and what
 * the operator is inside it. A body id is a name, never authorization.
 */
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const result = await listServiceWorkspaces(createSupabaseServiceRoleClient(), admin.userId);
  if (!result.ok) return failure(result);
  return NextResponse.json(result.payload, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  const id = typeof body.id === "string" ? body.id : "";

  switch (body.action) {
    case "create": {
      const result = await createServiceWorkspace(db, admin.userId, { name: body.name, city: body.city, ownerOfRecord: body.ownerOfRecord });
      if (!result.ok) return failure(result);
      return NextResponse.json({ id: result.id }, { status: 201, headers: NO_STORE });
    }
    case "attach-candidates": {
      const result = await listServiceAttachCandidates(db, admin.userId, body.query);
      if (!result.ok) return failure(result);
      return NextResponse.json({ candidates: result.candidates }, { headers: NO_STORE });
    }
    case "attach": {
      // Flags an existing workspace as PropLane Service; its owner and every property row stay as they are.
      const result = await attachWorkspaceToService(db, admin.userId, {
        workspaceId: body.workspaceId,
        city: body.city,
        label: body.label,
        reason: body.reason,
      });
      if (!result.ok) return failure(result);
      return NextResponse.json({ id: result.id }, { status: 201, headers: NO_STORE });
    }
    case "rename": {
      const result = await renameServiceWorkspace(db, admin.userId, { id, name: body.name, city: body.city, ownerOfRecord: body.ownerOfRecord });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "fee": {
      const result = await setServiceWorkspaceFee(db, admin.userId, { id, percent: body.percent });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true, feePercent: result.feePercent }, { headers: NO_STORE });
    }
    case "open": {
      const result = await authorizeOpenServiceWorkspace(db, admin.userId, id);
      if (!result.ok) return failure(result);
      const response = NextResponse.json({ ok: true, activeWorkspaceId: result.id, href: SERVICE_OPEN_HREF }, { headers: NO_STORE });
      // The same cookie the manager portal's own switcher sets (`POST /api/workspaces` action "select").
      response.cookies.set(WORKSPACE_COOKIE, result.id, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      return response;
    }
    case "team": {
      const result = await listServiceTeam(db, admin.userId, id);
      if (!result.ok) return failure(result);
      return NextResponse.json(
        { members: result.members, candidates: result.candidates, canManage: result.canManage },
        { headers: NO_STORE },
      );
    }
    case "team-add": {
      const result = await addServiceTeamMember(db, admin.userId, { id, userId: body.userId });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true, linkId: result.linkId }, { status: 201, headers: NO_STORE });
    }
    case "team-invite": {
      const result = await inviteServiceClient(db, admin.userId, { id, proplaneId: body.proplaneId, ownerOfRecord: body.ownerOfRecord });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true, linkId: result.linkId }, { status: 201, headers: NO_STORE });
    }
    case "team-owner-of-record": {
      const result = await setServiceOwnerOfRecord(db, admin.userId, { id, linkId: body.linkId, value: body.value });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "team-remove": {
      const result = await removeServiceTeamMember(db, admin.userId, { id, linkId: body.linkId });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    default:
      return NextResponse.json({ error: "Unknown service action." }, { status: 400, headers: NO_STORE });
  }
}
