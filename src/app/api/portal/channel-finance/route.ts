import { NextResponse } from "next/server";

import { managerCanWriteCalendarForProperty } from "@/lib/auth/manager-lease-scope";
import { airbnbPayoutRowsFromBookings } from "@/lib/channel-calendar/airbnb-payouts";
import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import { requireChannelFinanceContext } from "@/lib/channel-finance/access.server";
import { channelIncomeRows } from "@/lib/channel-finance/income";
import { assignFinanceRoom, confirmFinanceRecord, deleteFinanceRecord, dismissFinanceMail, financeMailSummary, listFinanceRecords, loadFinanceCandidates } from "@/lib/channel-finance/store.server";

export const runtime = "nodejs";

/** Channel income for the signed-in manager: every row (paid, expected, overdue, needs a room, needs review), the rooms a row can be assigned to, and the forwarding mail's status. Read-only; owner = the session user. */
export async function GET() {
  try {
    const ctx = await requireChannelFinanceContext("read");
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { data } = await ctx.db.from("external_calendar_connections").select("property_id").eq("manager_user_id", ctx.scope.ownerUserId);
    const inWorkspace = new Set(ctx.propertyIds);
    const propertyIds = [...new Set((data ?? []).map((row) => String((row as { property_id?: unknown }).property_id ?? "")).filter((id) => id && inWorkspace.has(id)))];
    const [records, mail, candidates, properties] = await Promise.all([
      listFinanceRecords(ctx.db, ctx.scope),
      financeMailSummary(ctx.db, ctx.scope),
      loadFinanceCandidates(ctx.db, { ownerUserId: ctx.scope.ownerUserId, workspaceId: ctx.scope.workspaceId }),
      listManagerChannelCalendarBookings(ctx.db, ctx.viewerUserId, propertyIds).catch(() => []),
    ]);
    const rows = channelIncomeRows({ records, stayPayouts: airbnbPayoutRowsFromBookings(properties), today: new Date().toISOString().slice(0, 10) });
    const rooms = candidates.map((c) => ({ propertyId: c.propertyId, propertyLabel: c.propertyLabel, roomId: c.roomId, roomLabel: c.roomLabel }));
    return NextResponse.json({ rows, rooms, mail }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

/** Review actions on one record: assign a room, confirm a flagged read, delete a mis-filed one; or dismiss a flagged mail. */
export async function PATCH(req: Request) {
  try {
    const ctx = await requireChannelFinanceContext("edit");
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
    if (action === "assign_room") {
      const propertyId = typeof body.propertyId === "string" ? body.propertyId : "";
      const roomId = typeof body.roomId === "string" ? body.roomId : "";
      if (!propertyId || !roomId) return NextResponse.json({ error: "Pick a room." }, { status: 400 });
      if (!(await managerCanWriteCalendarForProperty(ctx.db, ctx.viewerUserId, propertyId))) return NextResponse.json({ error: "No access to that house." }, { status: 403 });
      const result = await assignFinanceRoom(ctx.db, { scope: ctx.scope, recordId: id, propertyId, roomId });
      return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: result.error }, { status: result.status });
    }
    if (action === "confirm") return (await confirmFinanceRecord(ctx.db, ctx.scope, id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Could not confirm." }, { status: 404 });
    if (action === "delete") return (await deleteFinanceRecord(ctx.db, ctx.scope, id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Could not delete." }, { status: 500 });
    if (action === "dismiss_mail") return (await dismissFinanceMail(ctx.db, ctx.scope, id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Could not dismiss." }, { status: 500 });
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
