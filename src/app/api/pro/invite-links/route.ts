import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { inviteLinkUrl } from "@/lib/invite-links/invite-link-model";
import {
  listInviteLinks,
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
export async function GET() {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const links = await listInviteLinks(createSupabaseServiceRoleClient(), userId);
  return NextResponse.json({ links });
}

export async function POST(req: Request) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    label?: string;
    assignedPropertyIds?: unknown;
    propertyPermissions?: unknown;
    expiry?: string;
    uses?: string;
  };

  const result = await mintInviteLink(createSupabaseServiceRoleClient(), {
    ownerUserId: userId,
    kind: body.kind,
    label: body.label,
    assignedPropertyIds: Array.isArray(body.assignedPropertyIds)
      ? body.assignedPropertyIds.map((id) => String(id))
      : [],
    propertyPermissions: body.propertyPermissions,
    expiryOption: body.expiry,
    usesOption: body.uses,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // The one and only time the raw token leaves the server.
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
    ownerUserId: userId,
    linkId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ ok: true });
}
