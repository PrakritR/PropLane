"use client";

import { useEffect, useState } from "react";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { startOfWeekMonday } from "@/lib/demo-admin-scheduling";

export type GoogleCalendarBusyWarning = {
  warning?: string;
  hint?: string;
  /** The window held more events than the server would page through. */
  truncated?: boolean;
};

/** Warning code the events route returns when it could not load the whole window. */
export const GOOGLE_BUSY_TRUNCATED_WARNING = "calendar_events_truncated";

/** Warning code for a read that failed outright — the grid is NOT known to be free. */
export const GOOGLE_BUSY_UNAVAILABLE_WARNING = "calendar_events_unavailable";

const GOOGLE_BUSY_UNAVAILABLE_HINT =
  "PropLane could not load your Google Calendar busy time, so this grid may be missing conflicts. Check Google Calendar before publishing availability.";

const INCOMPLETE_BUSY_WARNINGS = new Set<string>([
  GOOGLE_BUSY_TRUNCATED_WARNING,
  GOOGLE_BUSY_UNAVAILABLE_WARNING,
]);

/**
 * True for the warnings that mean "the busy overlay you are looking at is
 * incomplete", as opposed to the connection-setup warnings, which describe a
 * persistent account state either calendar can report.
 *
 * A surface that lets a manager act on the grid must surface these; a surface
 * that only displays it may leave them to the portfolio calendar.
 */
export function isGoogleBusyIncompleteWarning(code: string | undefined): boolean {
  return Boolean(code && INCOMPLETE_BUSY_WARNINGS.has(code));
}

/**
 * The manager's linked Google Calendar busy time, as calendar meetings.
 *
 * Lives in a hook because BOTH manager calendars need it. The portfolio
 * calendar fetched it inline and the per-property availability calendar never
 * fetched it at all, so a slot the portfolio view showed as "Blocked" was a
 * free, selectable window on the very screen where the manager publishes tour
 * availability — the one place a conflict must be visible (manager audit
 * F-CAL-6, a double-booking risk).
 *
 * Best-effort by design: not connected and API disabled resolve to an empty
 * list, and only the portfolio calendar toasts those, so a manager never gets
 * the same setup toast twice.
 *
 * ## A read that FAILED is never reported as a free calendar
 *
 * A non-OK response, a network error, and a response whose body does not carry
 * a `meetings` array all emit {@link GOOGLE_BUSY_UNAVAILABLE_WARNING} through
 * `onWarning` and leave the previously loaded meetings in place rather than
 * replacing them with an empty list. "Could not load conflicts" and "there are
 * no conflicts" render identically on a grid, and only one of them is safe to
 * publish over — so a 200 is only believed when it actually carries the list
 * (an edge or proxy error page can be an HTML 200).
 *
 * ## The window is BOUNDED — conflicts outside it are NOT shown
 *
 * One request covers a fixed window around today ({@link GOOGLE_BUSY_DAYS_BEFORE}
 * back through `daysAhead` forward), not whichever week the calendar is
 * showing. A manager who navigates past the end of it sees zero busy cells and
 * can publish tour availability straight on top of a Google meeting. That is a
 * narrower guarantee than either calendar implies, so the window is wide rather
 * than week-sized: one larger request is cheaper than refetching on every week
 * navigation, and every extra day is a conflict that becomes visible on BOTH
 * calendars.
 *
 * ## A TRUNCATED response means conflicts may be missing
 *
 * The server pages through the window but gives up after a bounded number of
 * pages, and Google returns events in start-time order — so anything dropped is
 * dropped from the FAR end of the range, which is the part the wide window
 * exists to cover. When that happens the response carries
 * {@link GOOGLE_BUSY_TRUNCATED_WARNING} and `truncated: true`, delivered through
 * `onWarning`. The meetings returned are still real, but they are not all of
 * them: a caller that lets a manager publish availability must say so rather
 * than present the grid as conflict-free. Test both incompleteness codes with
 * {@link isGoogleBusyIncompleteWarning} rather than naming them individually.
 */

/** Trailing days included so today's week is complete, not clipped at "now". */
export const GOOGLE_BUSY_DAYS_BEFORE = 7;

/** Forward span of the busy window. Beyond this, conflicts are not shown. */
export const GOOGLE_BUSY_DEFAULT_DAYS_AHEAD = 56;

type GoogleCalendarBusyResponse = { meetings?: DemoMeeting[] } & GoogleCalendarBusyWarning;

function unavailableResponse(): GoogleCalendarBusyResponse {
  return { warning: GOOGLE_BUSY_UNAVAILABLE_WARNING, hint: GOOGLE_BUSY_UNAVAILABLE_HINT };
}

export function useGoogleCalendarBusyMeetings(input: {
  enabled: boolean;
  /** Bump to refetch (a reconnect, a manual refresh). */
  refreshSignal?: number;
  daysAhead?: number;
  onWarning?: (warning: GoogleCalendarBusyWarning) => void;
  /**
   * Manager (default) reads `/api/portal/google-calendar/events`; a role
   * cloning the read onto its own storage (vendor) passes its own route —
   * same `{timeMin,timeMax}` query shape and `{meetings,warning,hint,truncated}`
   * response shape, gated on that role instead of manager.
   */
  endpoint?: string;
}): DemoMeeting[] {
  const {
    enabled,
    refreshSignal,
    daysAhead = GOOGLE_BUSY_DEFAULT_DAYS_AHEAD,
    onWarning,
    endpoint = "/api/portal/google-calendar/events",
  } = input;
  const [meetings, setMeetings] = useState<DemoMeeting[]>([]);

  useEffect(() => {
    if (!enabled) {
      setMeetings([]);
      return;
    }
    let cancelled = false;
    const weekStart = startOfWeekMonday(new Date());
    weekStart.setDate(weekStart.getDate() - GOOGLE_BUSY_DAYS_BEFORE);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + GOOGLE_BUSY_DAYS_BEFORE + daysAhead);
    void fetch(
      `${endpoint}?timeMin=${encodeURIComponent(
        weekStart.toISOString(),
      )}&timeMax=${encodeURIComponent(weekEnd.toISOString())}`,
      { credentials: "include" },
    )
      .then(async (res): Promise<GoogleCalendarBusyResponse> => {
        const data = (await res.json().catch(() => ({}))) as GoogleCalendarBusyResponse;
        if (!res.ok || !Array.isArray(data.meetings)) return unavailableResponse();
        return data;
      })
      .catch(unavailableResponse)
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data.meetings)) setMeetings(data.meetings);
        if (data.warning) {
          onWarning?.({ warning: data.warning, hint: data.hint, truncated: data.truncated });
        }
      });
    return () => {
      cancelled = true;
    };
    // `onWarning` is intentionally excluded: callers pass an inline closure, and
    // depending on it would refetch Google on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshSignal, daysAhead, endpoint]);

  return meetings;
}
