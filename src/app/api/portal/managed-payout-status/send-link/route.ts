import { NextResponse } from "next/server";
import { resolveManagerRouteActor } from "@/lib/auth/route-actor.server";
import { resolveManagedPayoutStaffContext, sendOwnerPayoutSetupLink } from "@/lib/managed-finance/payout-setup.server";

export const runtime = "nodejs";

/** POST { workspaceId }: email the workspace OWNER of record a link to set up their own payouts. Recipient is derived server-side. */
export async function POST(req: Request) {
  const actor = await resolveManagerRouteActor({ route: "managed-payout-send-link" });
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const body = (await req.json().catch(() => null)) as { workspaceId?: unknown } | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
  try {
    const ctx = await resolveManagedPayoutStaffContext(actor.db, actor.userId, workspaceId);
    if (!ctx.staff) return NextResponse.json({ error: "Only PropLane staff of a managed workspace can send this." }, { status: 403 });
    if (!ctx.ownerUserId) return NextResponse.json({ error: "This workspace has no owner of record yet." }, { status: 409 });
    const r = await sendOwnerPayoutSetupLink(actor.db, { workspaceId: ctx.workspaceId, workspaceName: ctx.workspaceName, ownerUserId: ctx.ownerUserId, staffUserId: actor.userId });
    if (!r.ok && r.status === "skipped") return NextResponse.json({ ok: true, alreadySentToday: true });
    if (!r.ok) return NextResponse.json({ error: "Could not send the link. Try again." }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[managed-payout-send-link]", e instanceof Error ? e.message : "error");
    return NextResponse.json({ error: "Could not send the link. Try again." }, { status: 503 });
  }
}
