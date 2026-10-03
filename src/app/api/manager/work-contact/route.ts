import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { resolveActiveManagerWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";

/** Public work channels for a manager the caller already has an accepted relationship with. */
export async function GET(request: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("relationshipId");
  if (!id) return NextResponse.json({ error: "Relationship required." }, { status: 400 });
  const { data: link, error } = await auth.db.from("account_link_invites")
    .select("inviter_user_id, invitee_user_id, workspace_id, status").eq("id", id).maybeSingle();
  if (error || !link || link.status !== "accepted" || ![link.inviter_user_id, link.invitee_user_id].includes(auth.userId)) {
    return NextResponse.json({ error: "Relationship not found." }, { status: 404 });
  }
  // The shared workspace's work identity belongs to its owner, regardless of which teammate is reading.
  const owner = String(link.inviter_user_id);
  const [phone, email] = await Promise.all([
    resolveActiveManagerSendNumber(auth.db, owner, link.workspace_id).catch(() => null),
    resolveActiveManagerWorkEmail(auth.db, owner, link.workspace_id).catch(() => null),
  ]);
  return NextResponse.json({ phone, email }, { headers: { "Cache-Control": "private, no-store" } });
}
