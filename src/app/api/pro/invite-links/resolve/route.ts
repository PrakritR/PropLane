import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { previewInviteLink } from "@/lib/invite-links/invite-links.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * The (+) Join box: a signed-in person pastes an invite link or types a
 * workspace code and sees the same thin preview the invite page shows.
 *
 * A code is short, so this is a guessing surface: sign-in is required, calls
 * are rate limited per user, and every miss (unknown, malformed, empty) is the
 * same flat 404 — no hint which part was wrong. Never returns the permission map.
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to join a workspace." }, { status: 401 });

  if (!(await rateLimit(`invite-resolve:${user.id}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429 });
  }

  if (!(await rateLimit(`invite-resolve-ip:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as { input?: unknown };
  const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });
  if (typeof body.input !== "string" || !body.input.trim() || body.input.length > 600) return notFound();

  const preview = await previewInviteLink(createSupabaseServiceRoleClient(), body.input, new Date(), { allowCode: true });
  if (!preview) return notFound();
  return NextResponse.json({
    kind: preview.kind,
    ownerName: preview.ownerName,
    ownerUserId: preview.ownerUserId,
    workspaceName: preview.workspaceName,
    propertyLabels: preview.propertyLabels,
    teamRole: preview.teamRole ?? null,
    houseScope: preview.houseScope ?? "selected",
    houseCount: preview.houseCount ?? preview.propertyLabels.length,
    canDo: preview.canDo ?? null,
    unusableReason: preview.unusableReason,
  });
}
