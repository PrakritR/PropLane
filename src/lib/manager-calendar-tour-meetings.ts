import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import {
  MEETING_CONFIRMED_COLOR,
  MEETING_PEER_COLOR,
  MEETING_PENDING_COLOR,
} from "@/components/portal/portal-calendar-panels";
import {
  plannedTaskVisibleToViewer,
  plannedTourVisibleToViewer,
  tourInquiryVisibleToViewer,
  type ScheduledTourFilter,
} from "@/lib/co-manager-calendar";
import {
  ADMIN_AVAILABILITY_STORAGE_KEY,
  durationMinutesBetweenIso,
  getPartnerInquiryWindows,
  readPartnerInquiries,
  readPlannedEvents,
  SLOT_DURATION_MINUTES,
  startOfWeekMonday,
  toLocalDateStr,
} from "@/lib/demo-admin-scheduling";

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  x.setDate(x.getDate() + n);
  return x;
}

export function weekDateStrSet(anchorDate: Date): Set<string> {
  const monday = startOfWeekMonday(anchorDate);
  return new Set([0, 1, 2, 3, 4, 5, 6].map((i) => toLocalDateStr(addDays(monday, i))));
}

export function meetingsInWeek(meetings: DemoMeeting[], anchorDate: Date): DemoMeeting[] {
  const weekDates = weekDateStrSet(anchorDate);
  return meetings.filter((meeting) => weekDates.has(meeting.dateStr));
}

/** Planned + pending tour meetings visible to the manager calendar filter. */
export function buildScheduledTourMeetings(
  scheduledTourFilter: ScheduledTourFilter | undefined,
  storageKey: string | null,
): DemoMeeting[] {
  const showAdminMeetings =
    storageKey === ADMIN_AVAILABILITY_STORAGE_KEY ||
    Boolean(storageKey?.startsWith("axis_admin_avail_slots_v2_admin_"));
  const showManagerTours = Boolean(scheduledTourFilter?.viewerUserId);

  const planned = (showAdminMeetings || showManagerTours)
    ? readPlannedEvents()
        .filter((event) => {
          if (event.kind === "task") {
            if (!scheduledTourFilter) return false;
            return plannedTaskVisibleToViewer(event, scheduledTourFilter);
          }
          if (showAdminMeetings) return event.kind !== "tour";
          if (!scheduledTourFilter) return false;
          return plannedTourVisibleToViewer(event, scheduledTourFilter);
        })
        .map((event) => {
          const start = new Date(event.start);
          const durationMinutes = durationMinutesBetweenIso(event.start, event.end);
          const isPeerTour =
            event.kind === "tour" &&
            Boolean(scheduledTourFilter) &&
            event.managerUserId !== scheduledTourFilter?.viewerUserId;
          const hostPeer = scheduledTourFilter?.peers.find((peer) => peer.userId === event.managerUserId);
          return {
            id: `planned-${event.id}`,
            source: "planned",
            sourceId: event.id,
            startIso: event.start,
            endIso: event.end,
            dateStr: toLocalDateStr(start),
            startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
            span: Math.max(1, Math.ceil(durationMinutes / SLOT_DURATION_MINUTES)),
            durationMinutes,
            title: event.title,
            color: isPeerTour ? MEETING_PEER_COLOR : MEETING_CONFIRMED_COLOR,
            statusLabel: event.kind === "task" ? "Task" : isPeerTour ? "Co-manager tour" : "Confirmed",
            name: event.attendeeName,
            email: event.attendeeEmail,
            phone: event.attendeePhone,
            notes: event.notes,
            propertyTitle: event.propertyTitle,
            propertyId: event.propertyId,
            roomLabel: event.roomLabel,
            instructions: event.instructions,
            kind: event.kind,
            sourceTaskId: event.sourceTaskId,
            hostLabel: hostPeer?.label,
            isPeerTour,
          } satisfies DemoMeeting;
        })
    : [];

  const pending = readPartnerInquiries()
    .filter((row) => row.status === "pending")
    .filter((row) => {
      if (showAdminMeetings) return row.kind !== "tour";
      if (!showManagerTours || !scheduledTourFilter) return false;
      return tourInquiryVisibleToViewer(row, scheduledTourFilter);
    })
    .flatMap((row) =>
      getPartnerInquiryWindows(row)
        .map((window, index) => {
          const start = new Date(window.start);
          const end = new Date(window.end);
          if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            return null;
          }
          const durationMinutes = durationMinutesBetweenIso(window.start, window.end);
          return {
            id: `inquiry-${row.id}-${index}`,
            source: "inquiry",
            sourceId: row.id,
            startIso: window.start,
            endIso: window.end,
            dateStr: toLocalDateStr(start),
            startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
            span: Math.max(1, Math.ceil(durationMinutes / SLOT_DURATION_MINUTES)),
            durationMinutes,
            title: row.kind === "tour" ? `Tour · ${row.name}` : `${row.name} request`,
            color: MEETING_PENDING_COLOR,
            statusLabel: row.kind === "tour" ? "Tour requested" : "Requested",
            name: row.name,
            email: row.email,
            phone: row.phone,
            notes: row.notes,
            propertyTitle: row.propertyTitle,
            propertyId: row.propertyId,
            roomLabel: row.roomLabel,
            kind: row.kind,
          } satisfies DemoMeeting;
        })
        .filter(Boolean),
    ) as DemoMeeting[];

  return [...planned, ...pending];
}
