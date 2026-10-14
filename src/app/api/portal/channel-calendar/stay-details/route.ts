import { NextResponse } from "next/server";

import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { readChannelStayDetails, saveChannelStayDetails } from "@/lib/channel-calendar/stay-details.server";

export const runtime = "nodejs";

/**
 * The guest name a manager types for an imported channel stay (the Airbnb feed never carries one).
 * The body or query names only the connection, the feed's event UID and - for a host block, whose
 * UID the feed reuses across blocks - that block's dates. The house is re-derived from the
 * connection row, the caller's Calendar access to it is checked against the session, and the row
 * the details are stored on is derived from the connection's own imported range, never from the
 * dates in the request. A `propertyId` in the request is ignored.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const params = new URL(req.url).searchParams;
    const result = await readChannelStayDetails(ctx.db, ctx.userId, {
      connectionId: params.get("connectionId") ?? "",
      sourceUid: params.get("sourceUid") ?? "",
      start: params.get("start") ?? "",
      end: params.get("end") ?? "",
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.value);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as {
      connectionId?: unknown;
      sourceUid?: unknown;
      start?: unknown;
      end?: unknown;
      guestName?: unknown;
      notes?: unknown;
      guestPhone?: unknown;
      nightlyCents?: unknown;
      payoutCents?: unknown;
      paidAt?: unknown;
    };
    const result = await saveChannelStayDetails(ctx.db, ctx.userId, {
      connectionId: String(body.connectionId ?? ""),
      sourceUid: String(body.sourceUid ?? ""),
      // A host block's UID is shared across its blocks; the dates say which one.
      start: String(body.start ?? ""),
      end: String(body.end ?? ""),
      guestName: body.guestName,
      notes: body.notes,
      guestPhone: body.guestPhone,
      nightlyCents: body.nightlyCents,
      payoutCents: body.payoutCents,
      paidAt: body.paidAt,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.value);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
