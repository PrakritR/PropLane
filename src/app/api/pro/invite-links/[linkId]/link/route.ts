import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAppOrigin } from "@/lib/app-url";
import { inviteLinkUrl } from "@/lib/invite-links/invite-link-model";
import { revealInviteLinkToken, rotateInviteLinkToken } from "@/lib/invite-links/invite-links.server";

export const runtime = "nodejs";

/**
 * Copy returns the same live URL. Pass `{ rotate: true }` to mint a new token
 * and invalidate the previous one.
 */
export async function POST(req: Request, ctx: { params: Promise<{ linkId: string }> }) {
  const { linkId } = await ctx.params;
  const id = linkId?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "linkId is required." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { rotate?: unknown };
  const rotate = body.rotate === true;
  const db = createSupabaseServiceRoleClient();
  const result = rotate
    ? await rotateInviteLinkToken(db, { actorUserId: user.id, linkId: id })
    : await revealInviteLinkToken(db, { actorUserId: user.id, linkId: id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    ok: true,
    rotated: rotate,
    link: result.link,
    url: inviteLinkUrl(resolveAppOrigin(req), result.token),
  });
}
