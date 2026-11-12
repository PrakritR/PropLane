import { NextResponse } from "next/server";

import { listRemovedChannelStaysWithLabels } from "@/lib/channel-calendar/bookings.server";
import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import {
  removeChannelStay,
  resolveTombstoneRestoreInput,
  restoreChannelStay,
} from "@/lib/channel-calendar/stay-tombstones.server";
import { persistConnectionImportedRanges, syncChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";

export const runtime = "nodejs";

/**
 * The "Removed stays" list: the stays removed from the channel calendars of the houses the caller may EDIT
 * the calendar of (the gate Remove and Restore use). `?propertyIds=a,b` narrows it; without it, the
 * caller's own houses. Houses are re-checked server-side, so a name in the query is never a grant.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const raw = new URL(req.url).searchParams.get("propertyIds") ?? "";
    const propertyIds = raw.split(",").map((id) => id.trim()).filter(Boolean);
    const removed = await listRemovedChannelStaysWithLabels(ctx.db, ctx.userId, propertyIds);
    return NextResponse.json({ removed });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

/**
 * Remove stay / Restore for a stay that came from a channel calendar feed (C2-AB7).
 * The connection and its house are read from the database and the caller's
 * access to that house is checked against the session; the body names only the
 * connection and the feed's event UID (or, for Restore from the list, the tombstone's id).
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown; connectionId?: unknown; sourceUid?: unknown; start?: unknown; end?: unknown; tombstoneId?: unknown;
    };
    const action = body.action === "restore" ? "restore" : body.action === "remove" ? "remove" : null;
    if (!action) return NextResponse.json({ error: "action must be remove or restore." }, { status: 400 });
    let input = { connectionId: String(body.connectionId ?? ""), sourceUid: String(body.sourceUid ?? ""),
      start: String(body.start ?? "").trim() || undefined,
      end: String(body.end ?? "").trim() || undefined,
    };
    const tombstoneId = String(body.tombstoneId ?? "").trim();
    if (action === "restore" && tombstoneId) {
      // The list restores by the tombstone's own id; the connection it names is authorized below like any other.
      const resolved = await resolveTombstoneRestoreInput(ctx.db, tombstoneId);
      if (!resolved) return NextResponse.json({ error: "That stay was not removed." }, { status: 404 });
      input = { ...resolved, start: resolved.start || undefined, end: resolved.end || undefined };
    }

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

    // A restored stay reappears at once: that connection re-reads its feed (the tombstone is gone, so nothing
    // holds it back). The restore itself already succeeded, so a feed that cannot be read only says so.
    let synced = false;
    if (action === "restore") {
      try {
        await syncChannelCalendarConnection(ctx.db, input.connectionId.trim());
        synced = true;
      } catch {
        synced = false;
      }
    }
    return NextResponse.json({ ok: true, ...(action === "restore" ? { synced } : {}) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
