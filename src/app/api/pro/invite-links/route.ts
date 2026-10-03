import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAppOrigin } from "@/lib/app-url";
import { inviteLinkUnusableReason, inviteLinkUrl } from "@/lib/invite-links/invite-link-model";
import {
  listInviteLinksForActor,
  listInviteLinksForWorkspace,
  mintInviteLink,
  revokeInviteLink,
} from "@/lib/invite-links/invite-links.server";

export const runtime = "nodejs";

async function sessionUserId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/** The owner's own links, as metadata. The token is never returned again. */
export async function GET(req: Request) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId")?.trim();

  if (workspaceId) {
    // Live invite links for this workspace only (revoked rows are omitted).
    const result = await listInviteLinksForWorkspace(
      createSupabaseServiceRoleClient(),
      { actorUserId: userId, workspaceId },
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const now = new Date();
    const active =
      result.links.find((link) => !inviteLinkUnusableReason(link, now)) ?? null;
    return NextResponse.json({ links: result.links, link: active });
  }

  // Get all links for the actor.
  const links = await listInviteLinksForActor(createSupabaseServiceRoleClient(), userId);
  return NextResponse.json({ links });
}

export async function POST(req: Request) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    label?: string;
    assignedPropertyIds?: unknown;
    assignedRoomId?: string;
    propertyPermissions?: unknown;
    expiry?: string;
    uses?: string;
    workspaceId?: string;
    propertyLabelsById?: unknown;
    teamRole?: unknown;
    houseScope?: unknown;
    workspacePermissions?: unknown;
    replaceActive?: boolean;
  };

  const propertyLabelsById: Record<string, string> = {};
  if (body.propertyLabelsById && typeof body.propertyLabelsById === "object" && !Array.isArray(body.propertyLabelsById)) {
    for (const [id, label] of Object.entries(body.propertyLabelsById as Record<string, unknown>)) {
      if (typeof label === "string" && label.trim()) propertyLabelsById[id] = label.trim();
    }
  }

  const result = await mintInviteLink(createSupabaseServiceRoleClient(), {
    actorUserId: userId,
    kind: body.kind,
    label: body.label,
    assignedPropertyIds: Array.isArray(body.assignedPropertyIds)
      ? body.assignedPropertyIds.map((id) => String(id))
      : [],
    assignedRoomId: typeof body.assignedRoomId === "string" ? body.assignedRoomId : undefined,
    propertyPermissions: body.propertyPermissions,
    expiryOption: body.expiry,
    usesOption: body.uses,
    workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
    propertyLabelsById,
    teamRole: body.teamRole,
    houseScope: body.houseScope,
    workspacePermissions: body.workspacePermissions,
    replaceActive: body.replaceActive === true,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    link: result.link,
    // Sandbox panes each bind a different port — use the request Host, not
    // NEXT_PUBLIC_APP_URL, so a link minted on :3004 is not stamped :3005.
    url: inviteLinkUrl(resolveAppOrigin(req), result.token),
  });
}

export async function DELETE(req: Request) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const linkId = searchParams.get("id")?.trim() ?? "";
  if (!linkId) return NextResponse.json({ error: "id required" }, { status: 400 });
  const result = await revokeInviteLink(createSupabaseServiceRoleClient(), {
    actorUserId: userId,
    linkId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 404 });
  return NextResponse.json({ ok: true });
}

/** Changing a link's terms replaces its URL; an already-shared URL never gains access. */
export async function PATCH(req: Request) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.id !== "string" || typeof body.workspaceId !== "string") {
    return NextResponse.json({ error: "Link and workspace required." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  const listing = await listInviteLinksForWorkspace(db, { actorUserId: userId, workspaceId: body.workspaceId });
  if (!listing.ok) return NextResponse.json({ error: listing.error }, { status: listing.status });
  const original = listing.links.find((link) => link.id === body.id);
  if (!original || inviteLinkUnusableReason(original, new Date())) {
    return NextResponse.json({ error: "That invite link is no longer active." }, { status: 409 });
  }
  const replacement = await mintInviteLink(db, {
    actorUserId: userId,
    kind: "manager",
    workspaceId: body.workspaceId,
    label: original.label ?? undefined,
    assignedPropertyIds: Array.isArray(body.assignedPropertyIds) ? body.assignedPropertyIds : original.assignedPropertyIds,
    houseScope: body.houseScope ?? original.houseScope,
    teamRole: body.teamRole ?? original.teamRole,
    propertyPermissions: body.propertyPermissions ?? original.propertyPermissions,
    workspacePermissions: body.workspacePermissions ?? original.workspacePermissions,
    replaceActive: false,
  });
  if (!replacement.ok) return NextResponse.json({ error: replacement.error }, { status: replacement.status });
  // Keep the original deadline and remaining use budget. Never extend an invitation by editing it.
  const maxUses = original.maxUses === null ? null : original.maxUses - original.usedCount;
  const { error } = await db.from("manager_invite_links").update({ expires_at: original.expiresAt, max_uses: maxUses }).eq("id", replacement.link.id);
  if (error) {
    await revokeInviteLink(db, { actorUserId: userId, linkId: replacement.link.id });
    return NextResponse.json({ error: "Could not preserve the invitation limits." }, { status: 500 });
  }
  const revoked = await revokeInviteLink(db, { actorUserId: userId, linkId: original.id });
  if (!revoked.ok) {
    await revokeInviteLink(db, { actorUserId: userId, linkId: replacement.link.id });
    return NextResponse.json({ error: revoked.error }, { status: revoked.status ?? 409 });
  }
  return NextResponse.json({ link: { ...replacement.link, expiresAt: original.expiresAt, maxUses }, url: inviteLinkUrl(resolveAppOrigin(req), replacement.token) });
}
