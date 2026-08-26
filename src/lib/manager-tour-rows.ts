/**
 * Scheduled tours as LIST rows, grouped by the person who booked them.
 *
 * The Tours section was a week grid, which answers "what does Wednesday look like" but not "who
 * has a tour booked, and when" — the question a manager opens the tab to answer, and the one
 * Payments already answers for charges.
 *
 * The rows are built from `buildScheduledTourMeetings`, the SAME function the calendar draws, so
 * the table and the grid can never disagree about which tours exist. That matters more than it
 * looks: the two sit behind one tab, and a tour visible in one view but not the other reads as
 * lost data. In particular that function is what merges the two sources a manager thinks of as
 * one list — accepted tours (planned events) and tours still awaiting a reply (inquiries).
 *
 * Pure: it takes already-built meetings and returns rows. Reading storage stays with the caller.
 */
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { clusterRowsByResident, type ResidentCluster } from "@/lib/resident-row-clustering";

export type ManagerTourRow = {
  id: string;
  /** Named to match the shared resident-identity rule so clustering is the same everywhere. */
  residentName: string;
  residentEmail: string;
  residentPhone: string;
  startIso: string;
  endIso: string;
  propertyLabel: string;
  roomLabel: string;
  /** The meeting's own wording — "Confirmed", "Tour requested", "Co-manager tour". */
  statusLabel: string;
  /** False while the guest is still waiting on the manager to accept the time. */
  confirmed: boolean;
  notes: string;
};

export type ManagerTourCluster = ResidentCluster<ManagerTourRow>;

/**
 * Whether the guest has been told this time is happening.
 *
 * Read from the status the meeting builder already assigned rather than re-deriving it: a pending
 * inquiry is labelled "Tour requested", everything else has been accepted. Deliberately
 * conservative — anything unrecognised counts as NOT confirmed, because telling a manager a tour
 * is confirmed when the guest was never told is how somebody is left standing outside a property.
 */
export function tourMeetingConfirmed(statusLabel: string | undefined | null): boolean {
  const label = statusLabel?.toLowerCase().trim() ?? "";
  if (!label) return false;
  return !label.includes("request");
}

/** Only tours — the same feed carries partner meetings, which are not a manager's tour list. */
function isTourMeeting(meeting: DemoMeeting): boolean {
  return (meeting.kind ?? "tour") === "tour";
}

export function toManagerTourRows(meetings: readonly DemoMeeting[]): ManagerTourRow[] {
  return meetings
    .filter(isTourMeeting)
    .map((meeting) => ({
      id: meeting.id,
      residentName: meeting.name?.trim() ?? "",
      residentEmail: meeting.email?.trim() ?? "",
      residentPhone: meeting.phone?.trim() ?? "",
      startIso: meeting.startIso,
      endIso: meeting.endIso,
      propertyLabel: meeting.propertyTitle?.trim() ?? "",
      roomLabel: meeting.roomLabel?.trim() ?? "",
      statusLabel: meeting.statusLabel?.trim() ?? "",
      confirmed: tourMeetingConfirmed(meeting.statusLabel),
      notes: meeting.notes?.trim() ?? "",
    }))
    // Soonest first: the next tour is the one to act on, and it is what the grid put at the top
    // of the week too. Unparseable times sort last rather than scrambling the list.
    .sort((a, b) => {
      const at = Date.parse(a.startIso);
      const bt = Date.parse(b.startIso);
      if (!Number.isFinite(at)) return 1;
      if (!Number.isFinite(bt)) return -1;
      return at - bt;
    });
}

/** Group tour rows under one header per person, preserving the soonest-first order. */
export function clusterManagerTourRows(rows: readonly ManagerTourRow[]): ManagerTourCluster[] {
  return clusterRowsByResident(rows, (row) => row.propertyLabel || null);
}

/** How many of a person's tours are still waiting on the manager to accept a time. */
export function pendingTourCount(rows: readonly ManagerTourRow[]): number {
  return rows.filter((row) => !row.confirmed).length;
}
