import { NextResponse } from "next/server";
import { resolveManagerRouteActor } from "@/lib/auth/route-actor.server";
import { activeWorkspaceIdFromCookie, readOwnerPayoutStatus, resolveManagedPayoutStaffContext } from "@/lib/managed-finance/payout-setup.server";
import { stripeOrNull } from "@/lib/managed-finance/routes.server";

export const runtime = "nodejs";

/**
 * Balance & payouts for PropLane staff in a managed workspace: the OWNER's payout status (read from Stripe, masked bank
 * only) instead of any payout account of the viewer's own. `{ staff: false }` means the page renders as usual.
 */
export async function GET(req: Request) {
  const actor = await resolveManagerRouteActor({ route: "managed-payout-status" });
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status });
  try {
    const asked = new URL(req.url).searchParams.get("workspaceId")?.trim() || null;
    const ctx = await resolveManagedPayoutStaffContext(actor.db, actor.userId, asked ?? (await activeWorkspaceIdFromCookie()));
    if (!ctx.staff) return NextResponse.json({ staff: false });
    const stripe = stripeOrNull();
    if (!stripe) return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
    const status = await readOwnerPayoutStatus(stripe, actor.db, ctx.ownerUserId);
    return NextResponse.json({ staff: true, workspaceId: ctx.workspaceId, workspaceName: ctx.workspaceName, ...status });
  } catch (e) {
    console.error("[managed-payout-status]", e instanceof Error ? e.message : "error");
    return NextResponse.json({ error: "Could not read the owner's payout status. Try again." }, { status: 503 });
  }
}
