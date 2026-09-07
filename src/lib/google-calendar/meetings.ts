import { SLOT_DURATION_MINUTES, toLocalDateStr } from "@/lib/demo-admin-scheduling";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import type { GoogleCalendarApiEvent } from "@/lib/google-calendar/api.server";
import { googleEventBlocksTours, googleCalendarEventInformational } from "@/lib/google-calendar/busy";
import {
  PROPLANE_GOOGLE_CALENDAR_MARKER,
  PROPLANE_TOUR_TYPE_MARKER,
  PROPLANE_WORK_ORDER_TYPE_MARKER,
} from "@/lib/google-calendar/markers";

const GOOGLE_CALENDAR_TOUR_COLOR =
  "border-sky-300 bg-sky-100 text-sky-950 [html[data-theme=dark]_&]:portal-calendar-meeting-confirmed";

const GOOGLE_CALENDAR_WORK_ORDER_COLOR =
  "border-emerald-300 bg-emerald-100 text-emerald-950 [html[data-theme=dark]_&]:border-emerald-400/40 [html[data-theme=dark]_&]:bg-emerald-500/15 [html[data-theme=dark]_&]:text-emerald-100";

/** Muted busy blocks — personal Google events (titles hidden). */
export const GOOGLE_CALENDAR_BLOCKED_COLOR =
  "border-border bg-muted/50 text-muted ring-1 ring-inset ring-border/80 [html[data-theme=dark]_&]:bg-muted/30 [html[data-theme=dark]_&]:text-muted";

/** @deprecated Use {@link GOOGLE_CALENDAR_BLOCKED_COLOR} for private busy time. */
export const GOOGLE_CALENDAR_EVENT_COLOR = GOOGLE_CALENDAR_BLOCKED_COLOR;

function descriptionHasMarker(description: string | undefined, marker: string): boolean {
  return (description ?? "").toLowerCase().includes(marker.toLowerCase());
}

export type ProplaneGoogleCalendarDetails = {
  guestName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  instructions?: string;
  propertyTitle?: string;
  roomLabel?: string;
};

/** Parse PropPlane-pushed Google Calendar description lines into calendar meeting fields. */
export function parseProplaneGoogleCalendarDescription(
  description: string | undefined,
): ProplaneGoogleCalendarDetails {
  if (!description?.trim()) return {};
  const parsed: ProplaneGoogleCalendarDetails = {};
  const leftover: string[] = [];

  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (descriptionHasMarker(line, PROPLANE_TOUR_TYPE_MARKER) || descriptionHasMarker(line, PROPLANE_WORK_ORDER_TYPE_MARKER)) {
      continue;
    }
    if (descriptionHasMarker(line, PROPLANE_GOOGLE_CALENDAR_MARKER)) continue;

    const guest = line.match(/^guest:\s*(.+)$/i);
    if (guest) {
      parsed.guestName = guest[1]!.trim();
      continue;
    }
    const email = line.match(/^email:\s*(.+)$/i);
    if (email) {
      parsed.email = email[1]!.trim();
      continue;
    }
    const phone = line.match(/^phone:\s*(.+)$/i);
    if (phone) {
      parsed.phone = phone[1]!.trim();
      continue;
    }
    const instructions = line.match(/^instructions:\s*(.+)$/i);
    if (instructions) {
      parsed.instructions = instructions[1]!.trim();
      continue;
    }
    const room = line.match(/^room:\s*(.+)$/i);
    if (room) {
      parsed.roomLabel = room[1]!.trim();
      continue;
    }
    const notes = line.match(/^notes:\s*(.+)$/i);
    if (notes) {
      const value = notes[1]!.trim();
      const property = value.match(/^property:\s*(.+)$/i);
      if (property) {
        parsed.propertyTitle = property[1]!.trim();
      } else {
        parsed.notes = parsed.notes ? `${parsed.notes}\n${value}` : value;
      }
      continue;
    }
    const property = line.match(/^property:\s*(.+)$/i);
    if (property) {
      parsed.propertyTitle = property[1]!.trim();
      continue;
    }
    leftover.push(line);
  }

  if (!parsed.notes && leftover.length > 0) {
    parsed.notes = leftover.join("\n");
  }
  return parsed;
}

export function isPropPlaneGoogleTourMeeting(
  meeting: Pick<DemoMeeting, "source" | "kind" | "googleCalendarPrivate">,
): boolean {
  return meeting.source === "external" && meeting.kind === "tour" && !meeting.googleCalendarPrivate;
}

export function isPropPlaneGoogleServiceMeeting(
  meeting: Pick<DemoMeeting, "source" | "kind" | "googleCalendarPrivate">,
): boolean {
  return meeting.source === "external" && meeting.kind === "service" && !meeting.googleCalendarPrivate;
}

export function calendarMeetingSupportsDelete(
  meeting: Pick<DemoMeeting, "source" | "kind" | "googleCalendarPrivate" | "isPeerTour">,
): boolean {
  if (meeting.isPeerTour) return false;
  if (meeting.source === "planned" || meeting.source === "inquiry") return true;
  return isPropPlaneGoogleTourMeeting(meeting);
}

export function isGoogleCalendarTourEvent(event: GoogleCalendarApiEvent): boolean {
  if (descriptionHasMarker(event.description, PROPLANE_TOUR_TYPE_MARKER)) return true;
  if (descriptionHasMarker(event.description, PROPLANE_GOOGLE_CALENDAR_MARKER)) {
    return /^Tour\s*(?:[·\-–—]|$)/i.test(event.summary.trim());
  }
  return /^Tour\s*(?:[·\-–—]|$)/i.test(event.summary.trim());
}

export function isGoogleCalendarWorkOrderEvent(event: GoogleCalendarApiEvent): boolean {
  if (descriptionHasMarker(event.description, PROPLANE_WORK_ORDER_TYPE_MARKER)) return true;
  if (!descriptionHasMarker(event.description, PROPLANE_GOOGLE_CALENDAR_MARKER)) return false;
  return /^(?:My work|Service)\s*·/i.test(event.summary.trim()) || /\s·\s/.test(event.summary);
}

export function isGoogleCalendarPrivateBlock(
  meeting: Pick<DemoMeeting, "source" | "kind" | "googleCalendarPrivate">,
): boolean {
  return meeting.source === "external" && Boolean(meeting.googleCalendarPrivate);
}

/**
 * Meetings that count as EVENTS in a calendar's counters: tours and service
 * visits, never personal Google busy time.
 *
 * The day headers counted every meeting, busy blocks included, so a week with
 * no tours and no service orders read "7 EVENTS / 6 / 9 / 4 …" directly under
 * view tabs reading "All 0 · Tours 0 · Service orders 0" (manager audit
 * F-CAL-1). The busy blocks stay drawn in the grid, labelled "Blocked" — they
 * are simply not events, and the tabs never counted them.
 */
export function scheduledCalendarMeetings<
  T extends Pick<DemoMeeting, "source" | "kind" | "googleCalendarPrivate">,
>(meetings: readonly T[]): T[] {
  return meetings.filter((meeting) => !isGoogleCalendarPrivateBlock(meeting));
}

/** Label for calendar grid cells — never exposes personal Google event titles. */
export function meetingCalendarGridLabel(meeting: DemoMeeting): string {
  if (isGoogleCalendarPrivateBlock(meeting)) {
    return meeting.blocksTourAvailability === false ? "Free" : "Blocked";
  }
  if (meeting.source === "external" && meeting.kind === "tour") {
    return meeting.statusLabel ? `${meeting.statusLabel}: ${meeting.title}` : meeting.title;
  }
  if (meeting.source === "external" && meeting.kind === "service") {
    return meeting.statusLabel ? `${meeting.statusLabel}: ${meeting.title}` : meeting.title;
  }
  if (meeting.statusLabel) return `${meeting.statusLabel}: ${meeting.title}`;
  return meeting.title;
}

/**
 * Every Google event that blocks or is a PropLane tour/service becomes a meeting
 * the manager's calendar can draw. Free, declined, and informational Google
 * rows still exist in the list for future detail surfaces, but they no longer
 * paint grey "Blocked" cells — see {@link meetingPaintsCalendarGrid}.
 *
 * What varies is `blocksTourAvailability`, carried from the SAME
 * {@link googleEventBlocksTours} predicate the public booking route uses. Only
 * the "N open" math reads it, so the header agrees with what a prospect is
 * actually offered without anything disappearing from the calendar.
 */
export function googleCalendarEventsToMeetings(events: GoogleCalendarApiEvent[]): DemoMeeting[] {
  return events
    .map((event) => {
      const start = new Date(event.start);
      const end = new Date(event.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
      const blocksTourAvailability = googleEventBlocksTours(event);
      const informationalGoogleEvent = googleCalendarEventInformational(event);
      const dateStr = toLocalDateStr(start);
      const durationMinutes = Math.max(SLOT_DURATION_MINUTES, Math.round((end.getTime() - start.getTime()) / 60_000));
      const span = Math.max(1, Math.ceil(durationMinutes / SLOT_DURATION_MINUTES));
      const isTour = isGoogleCalendarTourEvent(event);
      const isWorkOrder = !isTour && isGoogleCalendarWorkOrderEvent(event);

      if (isTour) {
        const details = parseProplaneGoogleCalendarDescription(event.description);
        const title = event.summary.trim() || "Tour";
        const guestFromTitle = title.match(/^Tour\s*[·\-–—]\s*(.+)$/i)?.[1]?.trim();
        return {
          id: `google_${event.id}`,
          source: "external" as const,
          sourceId: event.id,
          startIso: start.toISOString(),
          endIso: end.toISOString(),
          dateStr,
          startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
          span,
          durationMinutes,
          title,
          color: GOOGLE_CALENDAR_TOUR_COLOR,
          statusLabel: "Confirmed",
          kind: "tour" as const,
          name: details.guestName ?? guestFromTitle,
          email: details.email,
          phone: details.phone,
          notes: details.notes,
          propertyTitle: details.propertyTitle,
          roomLabel: details.roomLabel,
          instructions: details.instructions,
          hostLabel: "Google Calendar",
          blocksTourAvailability,
          googleCalendarInformational: informationalGoogleEvent,
        } satisfies DemoMeeting;
      }

      if (isWorkOrder) {
        const details = parseProplaneGoogleCalendarDescription(event.description);
        return {
          id: `google_${event.id}`,
          source: "external" as const,
          sourceId: event.id,
          startIso: start.toISOString(),
          endIso: end.toISOString(),
          dateStr,
          startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
          span,
          durationMinutes,
          title: event.summary.trim() || "Service visit",
          color: GOOGLE_CALENDAR_WORK_ORDER_COLOR,
          statusLabel: "Scheduled",
          kind: "service" as const,
          notes: details.notes,
          propertyTitle: details.propertyTitle,
          hostLabel: "Google Calendar",
          blocksTourAvailability,
        } satisfies DemoMeeting;
      }

      return {
        id: `google_${event.id}`,
        source: "external" as const,
        sourceId: event.id,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        dateStr,
        startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
        span,
        durationMinutes,
        title: "Blocked",
        color: GOOGLE_CALENDAR_BLOCKED_COLOR,
        statusLabel: "Blocked",
        googleCalendarPrivate: true,
        googleCalendarInformational: informationalGoogleEvent,
        hostLabel: "Google Calendar",
        blocksTourAvailability,
      } satisfies DemoMeeting;
    })
    .filter(Boolean) as DemoMeeting[];
}
