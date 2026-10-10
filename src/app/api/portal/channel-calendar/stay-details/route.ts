import { NextResponse } from "next/server";

import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { readChannelStayDetails, saveChannelStayDetails } from "@/lib/channel-calendar/stay-details.server";

export const runtime = "nodejs";

/**
 * The guest name a manager types for an imported channel stay (the Airbnb feed never carries one).
 * The body or query names only the connection and the feed's event UID: the house is re-derived
 * from the connection row and the caller's Calendar access to it is checked against the session.
 * A `propertyId` in the request is ignored.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const params = new URL(req.url).searchParams;
    const result = await readChannelStayDetails(ctx.db, ctx.userId, {
      connectionId: params.get("connectionId") ?? "",
      sourceUid: params.get("sourceUid") ?? "",
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
      guestName?: unknown;
      notes?: unknown;
    };
    const result = await saveChannelStayDetails(ctx.db, ctx.userId, {
      connectionId: String(body.connectionId ?? ""),
      sourceUid: String(body.sourceUid ?? ""),
      guestName: body.guestName,
      notes: body.notes,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.value);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
