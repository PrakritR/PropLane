import { NextResponse } from "next/server";

import { airbnbPayoutRowsFromBookings, recordPayoutRows } from "@/lib/channel-calendar/airbnb-payouts";
import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { channelIncomeRows } from "@/lib/channel-finance/income";
import { requireChannelFinanceContext } from "@/lib/channel-finance/access.server";
import { listFinanceRecords } from "@/lib/channel-finance/store.server";

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
    const stayRows = airbnbPayoutRowsFromBookings(properties);
    // Payouts read from forwarded mail / CSV join the stay payouts; a stay a record already carries is drawn once, from the record.
    let payouts = stayRows;
    try {
      const finance = await requireChannelFinanceContext("read");
      if (!finance) throw new Error("no finance access");
      const records = await listFinanceRecords(ctx.db, finance.scope);
      const income = channelIncomeRows({ records, stayPayouts: stayRows, today: new Date().toISOString().slice(0, 10) });
      const linked = new Set(income.filter((row) => row.recordId && row.connectionId && row.sourceUid).map((row) => `${row.connectionId}:${row.sourceUid}`));
      payouts = [...stayRows.filter((row) => !linked.has(`${row.connectionId}:${row.sourceUid}`)), ...recordPayoutRows(income)];
    } catch {
      // Channel records are an addition: an unreadable table leaves the stay payouts as they were.
    }
    return NextResponse.json({ payouts }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
