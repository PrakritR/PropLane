import { NextResponse, after } from "next/server";

import { verifyGoogleCalendarChannelToken } from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { pullGoogleCalendarMeetings } from "@/lib/google-calendar/pull.server";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Google Calendar push-notification receiver (`events.watch`).
 *
 * No standing auth on this endpoint — Google calls it directly, unauthenticated
 * beyond whatever this route itself checks. Trust comes ENTIRELY from the
 * `X-Goog-Channel-Token` header: it is the HMAC-signed token
 * `watchGoogleCalendar` minted when the channel was created
 * (`api.server.ts`), and it is what recovers the manager id — the channel and
 * resource ids in the other headers are not secret and are not trusted alone.
 * A token that fails verification, or a channel/resource id that no longer
 * matches what is on file for that manager (the channel was replaced or the
 * manager disconnected), gets a quiet 200 with no pull — never a 4xx that
 * would make Google retry, and never a fallback guess at which manager this
 * notification was for.
 *
 * Always responds 200 quickly and does the actual pull in `after()` — Google
 * expects a fast ack and retries/backs off a channel that is slow or errors
 * repeatedly.
 */
export async function POST(req: Request) {
  const channelId = req.headers.get("x-goog-channel-id")?.trim() ?? "";
  const resourceId = req.headers.get("x-goog-resource-id")?.trim() ?? "";
  const resourceState = req.headers.get("x-goog-resource-state")?.trim() ?? "";
  const token = req.headers.get("x-goog-channel-token")?.trim() ?? "";

  if (!channelId || !token) {
    return NextResponse.json({ ok: true });
  }

  const managerUserId = verifyGoogleCalendarChannelToken(token);
  if (!managerUserId) {
    debugGoogleCalendarLog("google-calendar/webhook:POST", "unverifiable channel token", {
      hypothesisId: "H-WS3-webhook",
    });
    return NextResponse.json({ ok: true });
  }

  const db = createSupabaseServiceRoleClient();
  const connection = await loadGoogleCalendarConnection(db, managerUserId);
  if (
    connection.channelId !== channelId ||
    (resourceId && connection.channelResourceId && connection.channelResourceId !== resourceId)
  ) {
    // Stale or superseded channel (manager reconnected, channel was renewed) —
    // acknowledge and ignore rather than pulling on a channel PropLane no
    // longer believes is current.
    return NextResponse.json({ ok: true });
  }

  if (resourceState === "sync") {
    // The handshake notification `events.watch` sends immediately on channel
    // creation. There is nothing to pull yet.
    return NextResponse.json({ ok: true });
  }

  const pullTask = () =>
    pullGoogleCalendarMeetings(db, managerUserId).catch((e) =>
      console.warn(`[google-calendar] webhook pull failed for manager ${managerUserId.slice(-6)}`, e),
    );
  try {
    after(pullTask);
  } catch {
    void pullTask();
  }

  return NextResponse.json({ ok: true });
}
