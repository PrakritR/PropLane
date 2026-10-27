import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { previewInviteLink } from "@/lib/invite-links/invite-links.server";
import { parseInviteInput } from "@/lib/invite-links/invite-link-model";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * What an opener sees before signing in or accepting.
 *
 * Anyone holding the URL can call this, so it returns the inviter's name, the
 * property labels the link covers and — on a bound service invite — the one
 * email the link was sent to, so the sign-up field can be prefilled and locked
 * to it; never the owner's other holdings, never the permission map. A bad token
 * is a flat 404 so the endpoint is not an oracle for guessing valid ones.
 */
export async function POST(req: Request) {
  if (!(await rateLimit(`invite-preview-ip:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = body.token?.trim() ?? "";
  if (!token) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Workspace codes are short: they resolve only for a signed-in person (resolve route).
  if (parseInviteInput(token)?.kind === "code") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const preview = await previewInviteLink(createSupabaseServiceRoleClient(), token);
  if (!preview) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return NextResponse.json({
    kind: preview.kind,
    ownerName: preview.ownerName,
    workspaceName: preview.workspaceName,
    propertyLabels: preview.propertyLabels,
    teamRole: preview.teamRole ?? null,
    houseScope: preview.houseScope ?? "selected",
    houseCount: preview.houseCount ?? preview.propertyLabels.length,
    canDo: preview.canDo ?? null,
    access: preview.access ?? null,
    inviteeEmail: preview.inviteeEmail ?? null,
    ...(preview.kind === "admin"
      ? { adminRoleLabel: preview.adminRoleLabel ?? null, adminWorkspaceNames: preview.adminWorkspaceNames ?? [] }
      : {}),
    unusableReason: preview.unusableReason,
    ...(user ? { ownerUserId: preview.ownerUserId } : {}),
  });
}
