import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { inviteLinkUrl } from "@/lib/invite-links/invite-link-model";
import { rotateInviteLinkToken } from "@/lib/invite-links/invite-links.server";

export const runtime = "nodejs";

/** Rotate the shareable token on an active invite link and return a fresh URL. */
export async function POST(_req: Request, ctx: { params: Promise<{ linkId: string }> }) {
  const { linkId } = await ctx.params;
  const id = linkId?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "linkId is required." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const result = await rotateInviteLinkToken(createSupabaseServiceRoleClient(), {
    actorUserId: user.id,
    linkId: id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    ok: true,
    link: result.link,
    url: inviteLinkUrl(resolveEmailLinkBaseUrl(), result.token),
  });
}
