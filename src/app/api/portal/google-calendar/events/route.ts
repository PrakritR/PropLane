import { NextResponse, after } from "next/server";

import { assertGoogleCalendarProviderAllowed, classifyGoogleCalendarEventsFetchError, listGoogleCalendarEventsPaged } from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { googleCalendarEventsToMeetings } from "@/lib/google-calendar/meetings";
import { loadPersistedGoogleMeetings } from "@/lib/google-calendar/persisted-meetings.server";
import { pullGoogleCalendarMeetings } from "@/lib/google-calendar/pull.server";
import { deleteProplaneGoogleCalendarEvent } from "@/lib/google-calendar/sync.server";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "events_read");
    const url = new URL(req.url);
    const timeMin = url.searchParams.get("timeMin");
    const timeMax = url.searchParams.get("timeMax");
    if (!timeMin || !timeMax) {
      return NextResponse.json({ error: "timeMin and timeMax are required." }, { status: 400 });
    }
    const connection = await loadGoogleCalendarConnection(ctx.db, ctx.userId);
    debugGoogleCalendarLog("events/route.ts:GET", "loaded connection", {
      hypothesisId: "H2",
      connected: connection.connected,
      managerSuffix: ctx.userId.slice(-6),
    });
    if (!connection.connected) {
      return NextResponse.json({ meetings: [] });
    }

    // Poll-on-read fallback: WS3's chosen renewal/sync path for hosts where a
    // live Google push channel cannot be stood up (Testing-mode OAuth app, no
    // domain-verified webhook host — see pull.server.ts). Scheduled after the
    // response so a slow incremental sync never adds latency to this request;
    // the webhook route triggers the same function synchronously when push is
    // live, so a manager's calendar view is never the ONLY thing keeping the
    // mirror current.
    const pullTask = () =>
      pullGoogleCalendarMeetings(ctx.db, ctx.userId).catch((e) =>
        console.warn(`[google-calendar] poll-on-read pull failed for manager ${ctx.userId.slice(-6)}`, e),
      );
    try {
      after(pullTask);
    } catch {
      void pullTask();
    }

    // `google_meeting` rows the pull already persisted for this window are
    // read INDEPENDENTLY of the live call and merged in, deduped by Google
    // event id (live wins) — see `tour-availability.server.ts`'s busy path for
    // the same pattern. This is what makes a persisted meeting show up here
    // even when the live call is truncated, rate-limited, times out, or simply
    // has not re-run since the pull did.
    const persisted = await loadPersistedGoogleMeetings(ctx.db, ctx.userId, timeMin, timeMax);
    try {
      const { events, truncated } = await listGoogleCalendarEventsPaged(ctx.db, ctx.userId, timeMin, timeMax);
      const liveIds = new Set(events.map((event) => event.id));
      const merged = [...events, ...persisted.filter((event) => !liveIds.has(event.id))];
      const meetings = googleCalendarEventsToMeetings(merged);
      if (truncated) {
        return NextResponse.json({
          meetings,
          truncated: true,
          warning: "calendar_events_truncated",
          hint: "This calendar has more events than PropLane can load for the dates shown, so some busy time may be missing. Check Google Calendar before publishing availability far out.",
        });
      }
      return NextResponse.json({ meetings, truncated: false });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed";
      debugGoogleCalendarLog("events/route.ts:GET", "events fetch failed", {
        hypothesisId: "H2",
        message,
      });
      const classified = classifyGoogleCalendarEventsFetchError(message);
      if (classified) {
        return NextResponse.json({
          meetings: googleCalendarEventsToMeetings(persisted),
          warning: classified.warning,
          hint: classified.hint,
        });
      }
      throw e;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "events_delete");
    const eventId = new URL(req.url).searchParams.get("eventId")?.trim() ?? "";
    if (!eventId) return NextResponse.json({ error: "eventId is required." }, { status: 400 });
    const connection = await loadGoogleCalendarConnection(ctx.db, ctx.userId);
    if (!connection.connected) {
      return NextResponse.json({ error: "Google Calendar is not connected." }, { status: 400 });
    }
    await deleteProplaneGoogleCalendarEvent(ctx.db, ctx.userId, eventId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete calendar event.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
