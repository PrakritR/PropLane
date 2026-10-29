import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import { listAccountWorkspacesForManaging, manageAccountByProplane } from "@/lib/service/managed-by-proplane.server";
import {
  addServiceTeamMember,
  attachWorkspaceToService,
  authorizeOpenServiceWorkspace,
  createServiceWorkspace,
  inviteServiceClient,
  listServiceAttachCandidates,
  listServiceTeam,
  listServiceWorkspaces,
  releaseServiceWorkspaceOldNumber,
  removeServiceTeamMember,
  renameServiceWorkspace,
  setServiceOwnerOfRecord,
  setServiceWorkspaceFee,
  updateServiceTeamAccess,
  type ServiceFailure,
} from "@/lib/service/service-workspaces.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };
/** Where "Open" lands: the service-mode dashboard of that workspace (/portal reads the workspace cookie set below). */
const SERVICE_OPEN_HREF = "/portal/dashboard";

function failure(result: ServiceFailure) {
  return NextResponse.json(
    { error: result.error, ...(result.code ? { code: result.code, ownerName: result.ownerName } : {}) },
    { status: result.status, headers: NO_STORE },
  );
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
      const result = await createServiceWorkspace(db, admin.userId, {
        name: body.name,
        city: body.city,
        ownerOfRecord: body.ownerOfRecord,
        ownerContact: body.ownerContact,
        ownerRole: body.ownerRole,
      });
      if (!result.ok) return failure(result);
      return NextResponse.json({ id: result.id, ownerInvite: result.ownerInvite, workEmail: result.workEmail }, { status: 201, headers: NO_STORE });
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
    case "account-workspaces": {
      // Accounts > Managers > Managed by PropLane...: the account's own workspaces, re-read from the database.
      const result = await listAccountWorkspacesForManaging(db, admin.userId, body.accountUserId);
      if (!result.ok) return failure(result);
      return NextResponse.json(
        { account: result.account, workspaces: result.workspaces, managedCount: result.managedCount },
        { headers: NO_STORE },
      );
    }
    case "manage-by-proplane": {
      // One attach per chosen workspace, or Combine all into one. Audit rows first; a failed read changes nothing.
      const result = await manageAccountByProplane(db, admin.userId, {
        accountUserId: body.accountUserId,
        mode: body.mode,
        workspaceIds: body.workspaceIds,
        targetId: body.targetId,
        city: body.city,
        label: body.label,
        feePercent: body.feePercent,
      });
      if (!result.ok) return failure(result);
      return NextResponse.json(
        { attached: result.attached, moved: result.moved, archived: result.archived, kept: result.kept, feeErrors: result.feeErrors },
        { status: 201, headers: NO_STORE },
      );
    }
    case "rename": {
      const result = await renameServiceWorkspace(db, admin.userId, { id, name: body.name, city: body.city, ownerOfRecord: body.ownerOfRecord });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "fee": {
      const result = await setServiceWorkspaceFee(db, admin.userId, { id, percent: body.percent });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true, feePercent: result.feePercent, changed: result.changed }, { headers: NO_STORE });
    }
    case "release-old-number": {
      // Admin only (re-derived in the service layer); audited before the release; never the PropLane line itself.
      const result = await releaseServiceWorkspaceOldNumber(db, admin.userId, { id });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true, released: result.released }, { headers: NO_STORE });
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
      // Role, houses and module levels are parsed and re-derived by the service layer (the same validators the
      // manager invite uses); a body id or role is a request, never a grant.
      const result = await inviteServiceClient(db, admin.userId, {
        id,
        proplaneId: body.proplaneId,
        email: body.email,
        ownerOfRecord: body.ownerOfRecord,
        replaceOwner: body.replaceOwner,
        inviteeName: body.inviteeName,
        teamRole: body.teamRole,
        houseScope: body.houseScope,
        assignedPropertyIds: body.assignedPropertyIds,
        propertyCoManagerPermissions: body.propertyCoManagerPermissions,
        coManagerPermissions: body.coManagerPermissions,
        workspacePermissions: body.workspacePermissions,
      });
      if (!result.ok) return failure(result);
      return NextResponse.json(
        { ok: true, linkId: result.linkId, delivery: result.delivery, ownerReplaced: result.ownerReplaced },
        { status: 201, headers: NO_STORE },
      );
    }
    case "team-access": {
      const result = await updateServiceTeamAccess(db, admin.userId, {
        id,
        linkId: body.linkId,
        teamRole: body.teamRole,
        houseScope: body.houseScope,
        assignedPropertyIds: body.assignedPropertyIds,
        propertyCoManagerPermissions: body.propertyCoManagerPermissions,
        coManagerPermissions: body.coManagerPermissions,
        workspacePermissions: body.workspacePermissions,
      });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "team-owner-of-record": {
      const result = await setServiceOwnerOfRecord(db, admin.userId, { id, linkId: body.linkId, value: body.value });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "team-remove": {
      const result = await removeServiceTeamMember(db, admin.userId, { id, linkId: body.linkId, inviteLinkId: body.inviteLinkId });
      if (!result.ok) return failure(result);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    default:
      return NextResponse.json({ error: "Unknown service action." }, { status: 400, headers: NO_STORE });
  }
}
