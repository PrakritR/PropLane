import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
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
    // Saved invite links for this workspace (Active + Off), newest first.
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
    url: inviteLinkUrl(resolveEmailLinkBaseUrl(), result.token),
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
