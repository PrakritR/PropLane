import { NextResponse } from "next/server";

import {
  assertGoogleCalendarProviderAllowed,
  classifyGoogleCalendarEventsFetchError,
  listGoogleCalendarEventsPaged,
} from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { googleCalendarEventsToMeetings } from "@/lib/google-calendar/meetings";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Vendor clone of `/api/portal/google-calendar/events` — read-only busy time
 * for the vendor's OWN connected calendar (`api.server.ts` / `settings.ts`
 * operate purely on a bare `userId`, the same reuse-by-userId pattern the
 * connect/status routes already use), gated on the vendor role instead of
 * manager.
 *
 * Unlike the manager route, nothing is ever pushed onto a vendor's calendar —
 * no tour, service-visit, or availability sync writes to a vendor's own
 * Google account — so every event this reads back is genuinely personal busy
 * time; `googleCalendarEventsToMeetings` already treats an event with no
 * PropLane marker as a title-less "Blocked" (or Free, if transparent) private
 * block, which is exactly the read-only free/busy signal wanted here. This
 * intentionally skips the manager route's persisted-meeting mirror and
 * poll-on-read pull, which exist only to keep PropLane-AUTHORED events
 * durable across a webhook outage — nothing here is PropLane-authored.
 */
async function requireVendor() {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) return null;
  return { db: createSupabaseServiceRoleClient(), userId: resolved.userId };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireVendor();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "events_read");
    const url = new URL(req.url);
    const timeMin = url.searchParams.get("timeMin");
    const timeMax = url.searchParams.get("timeMax");
    if (!timeMin || !timeMax) {
      return NextResponse.json({ error: "timeMin and timeMax are required." }, { status: 400 });
    }
    const connection = await loadGoogleCalendarConnection(ctx.db, ctx.userId);
    if (!connection.connected) {
      return NextResponse.json({ meetings: [] });
    }

    try {
      const { events, truncated } = await listGoogleCalendarEventsPaged(ctx.db, ctx.userId, timeMin, timeMax);
      const meetings = googleCalendarEventsToMeetings(events);
      if (truncated) {
        return NextResponse.json({
          meetings,
          truncated: true,
          warning: "calendar_events_truncated",
          hint: "This calendar has more events than PropLane can load for the dates shown, so some busy time may be missing.",
        });
      }
      return NextResponse.json({ meetings, truncated: false });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed";
      debugGoogleCalendarLog("vendor/google-calendar/events:GET", "events fetch failed", {
        vendorSuffix: ctx.userId.slice(-6),
        message,
      });
      const classified = classifyGoogleCalendarEventsFetchError(message);
      if (classified) {
        return NextResponse.json({ meetings: [], warning: classified.warning, hint: classified.hint });
      }
      throw e;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
