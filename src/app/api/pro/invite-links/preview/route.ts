import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { previewInviteLink } from "@/lib/invite-links/invite-links.server";

export const runtime = "nodejs";

/**
 * What an opener sees before signing in or accepting.
 *
 * Anyone holding the URL can call this, so it returns the inviter's name and
 * the property labels the link covers and nothing else — never the owner's
 * other holdings, never the permission map. A bad token is a flat 404 so the
 * endpoint is not an oracle for guessing valid ones.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = body.token?.trim() ?? "";
  if (!token) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const preview = await previewInviteLink(createSupabaseServiceRoleClient(), token);
  if (!preview) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({
    kind: preview.kind,
    ownerName: preview.ownerName,
    propertyLabels: preview.propertyLabels,
    unusableReason: preview.unusableReason,
  });
}
