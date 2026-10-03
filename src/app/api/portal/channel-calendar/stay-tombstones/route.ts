import { NextResponse } from "next/server";

import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { removeChannelStay, restoreChannelStay } from "@/lib/channel-calendar/stay-tombstones.server";
import { persistConnectionImportedRanges } from "@/lib/channel-calendar/sync.server";

export const runtime = "nodejs";

/**
 * Remove stay / Undo for a stay that came from a channel calendar feed (C2-AB7).
 * The connection and its house are read from the database and the caller's
 * access to that house is checked against the session; the body names only the
 * connection and the feed's event UID.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { action?: unknown; connectionId?: unknown; sourceUid?: unknown };
    const action = body.action === "restore" ? "restore" : body.action === "remove" ? "remove" : null;
    if (!action) return NextResponse.json({ error: "action must be remove or restore." }, { status: 400 });
    const input = { connectionId: String(body.connectionId ?? ""), sourceUid: String(body.sourceUid ?? "") };

    const result =
      action === "remove"
        ? await removeChannelStay(ctx.db, ctx.userId, input, (connection, ranges) =>
            persistConnectionImportedRanges(ctx.db, connection, ranges, { removedUids: [input.sourceUid.trim()] }),
          )
        : await restoreChannelStay(ctx.db, ctx.userId, input, (connection, ranges) =>
            persistConnectionImportedRanges(ctx.db, connection, ranges, {
              restoredRanges: ranges.filter((range) => (range.sourceUid || range.id) === input.sourceUid.trim()),
            }),
          );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
