import { NextResponse } from "next/server";

import { managerCanWriteCalendarForProperty } from "@/lib/auth/manager-lease-scope";
import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { decideShortStayHold } from "@/lib/short-stay/hold-decisions.server";

export const runtime = "nodejs";

/**
 * The host answers a guest's short-stay request: `{ blockId, decision: "approve" | "decline" }`.
 * Approve confirms the hold and raises the stay charge; Decline cancels it and frees the nights. The
 * caller must own the house or hold Calendar at `edit` on it, re-derived here from the stored block -
 * an id in the body is never authorization.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { blockId?: unknown; decision?: unknown } | null;
    const blockId = typeof body?.blockId === "string" ? body.blockId.trim() : "";
    const decision = body?.decision === "approve" || body?.decision === "decline" ? body.decision : null;
    if (!blockId || !decision) return NextResponse.json({ error: "Choose a booking and an answer." }, { status: 400 });

    const { data: record } = await ctx.db
      .from("portal_schedule_records")
      .select("manager_user_id, property_id")
      .eq("id", blockId)
      .maybeSingle();
    if (!record) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
    const owner = String(record.manager_user_id ?? "").trim();
    const propertyId = String(record.property_id ?? "").trim();
    const allowed =
      owner === ctx.userId || (Boolean(propertyId) && (await managerCanWriteCalendarForProperty(ctx.db, ctx.userId, propertyId)));
    if (!allowed) return NextResponse.json({ error: "You need Calendar edit access on this property." }, { status: 403 });

    const result = await decideShortStayHold(ctx.db, { blockId, decision });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, outcome: result.outcome, chargeCreated: result.chargeCreated });
  } catch {
    return NextResponse.json({ error: "Could not save that answer." }, { status: 500 });
  }
}
