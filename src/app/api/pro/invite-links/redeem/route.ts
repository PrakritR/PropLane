import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { redeemInviteLink } from "@/lib/invite-links/invite-links.server";

export const runtime = "nodejs";

/**
 * Spend a use and produce the addressed invite the opener then accepts.
 *
 * The redeemer names nothing: the scope and permissions come off the stored
 * link, and this route never reads them from the body.
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to accept this invite." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = body.token?.trim() ?? "";
  if (!token) return NextResponse.json({ error: "That invite link is not valid." }, { status: 404 });

  const result = await redeemInviteLink(createSupabaseServiceRoleClient(), {
    token,
    redeemerUserId: user.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ inviteId: result.inviteId, alreadyRedeemed: result.alreadyRedeemed });
}
