import { NextResponse } from "next/server";

import { airbnbPayoutRowsFromBookings } from "@/lib/channel-calendar/airbnb-payouts";
import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";

export const runtime = "nodejs";

/**
 * Airbnb payouts for Incoming payments: every stay on the signed-in manager's own channel
 * connections that has a payout amount. Houses come from the connections the caller owns, and
 * `listManagerChannelCalendarBookings` re-checks Calendar access and the active workspace for each.
 */
export async function GET() {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { data, error } = await ctx.db.from("external_calendar_connections").select("property_id").eq("manager_user_id", ctx.userId);
    if (error) return NextResponse.json({ error: "Could not load payouts." }, { status: 500 });
    const propertyIds = [...new Set((data ?? []).map((row) => String((row as { property_id?: unknown }).property_id ?? "")).filter(Boolean))];
    const properties = await listManagerChannelCalendarBookings(ctx.db, ctx.userId, propertyIds);
    return NextResponse.json({ payouts: airbnbPayoutRowsFromBookings(properties) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
