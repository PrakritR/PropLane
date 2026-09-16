import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { GoogleCalendarApiEvent } from "@/lib/google-calendar/api.server";

/**
 * `google_meeting` rows persisted by `pullGoogleCalendarMeetings`
 * (`src/lib/google-calendar/pull.server.ts`), read back shaped EXACTLY like a
 * live-fetched {@link GoogleCalendarApiEvent}.
 *
 * That shape match is the point: callers feed the result straight into the
 * same predicates the live path already uses —
 * `googleEventBlocksTours` for busy-subtraction, `googleCalendarEventsToMeetings`
 * for calendar rendering — so a persisted row and a live-pulled one are judged
 * identically rather than by a second, drifting copy of the rules.
 *
 * Fails soft: a read error (including a test double that does not implement
 * the query chain used here) returns an empty list rather than throwing, the
 * same "no working calendar link contributes no busy time" trade the live
 * path already makes.
 */
export async function loadPersistedGoogleMeetings(
  db: SupabaseClient,
  managerUserId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<GoogleCalendarApiEvent[]> {
  const uid = managerUserId.trim();
  if (!uid) return [];
  try {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("row_data, starts_at, ends_at")
      .eq("record_type", "google_meeting")
      .eq("manager_user_id", uid);
    if (error || !Array.isArray(data)) return [];

    const timeMinMs = Date.parse(timeMinIso);
    const timeMaxMs = Date.parse(timeMaxIso);
    const events: GoogleCalendarApiEvent[] = [];

    for (const row of data as { row_data: unknown; starts_at: string | null; ends_at: string | null }[]) {
      const payload =
        row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)
          ? (row.row_data as Record<string, unknown>)
          : null;
      if (!payload) continue;
      const googleEventId = typeof payload.googleEventId === "string" ? payload.googleEventId : null;
      const start = typeof payload.start === "string" ? payload.start : row.starts_at;
      const end = typeof payload.end === "string" ? payload.end : row.ends_at;
      if (!googleEventId || !start || !end) continue;

      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      // Window overlap, matching the same exclusive-end convention `overlaps()`
      // (tour-slot-math.ts) uses everywhere else on this surface.
      if (Number.isFinite(timeMaxMs) && startMs >= timeMaxMs) continue;
      if (Number.isFinite(timeMinMs) && endMs <= timeMinMs) continue;

      events.push({
        id: googleEventId,
        summary:
          typeof payload.summary === "string" && payload.summary.trim()
            ? payload.summary.trim()
            : "Google Calendar event",
        description: typeof payload.description === "string" ? payload.description : undefined,
        start,
        end,
        transparency: payload.transparency === "transparent" ? "transparent" : "opaque",
        declinedBySelf: payload.declinedBySelf === true,
        allDay: payload.allDay === true,
        eventType: typeof payload.eventType === "string" ? payload.eventType : undefined,
      });
    }
    return events;
  } catch {
    return [];
  }
}
