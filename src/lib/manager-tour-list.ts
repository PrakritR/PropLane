import {
  listPropertyCalendarPeers,
  plannedTourVisibleToViewer,
  tourInquiryVisibleToViewer,
  type PropertyCalendarPeer,
  type ScheduledTourFilter,
} from "@/lib/co-manager-calendar";
import {
  formatRangeLabel,
  getPartnerInquiryWindows,
  readAllPlannedEvents,
  readPartnerInquiries,
  type PartnerInquiry,
  type PlannedEvent,
} from "@/lib/demo-admin-scheduling";
import type { ManagerTourBucketId } from "@/lib/portal-detail-routes";

export type ManagerTourRowSource = "inquiry" | "planned";

export type ManagerTourRow = {
  id: string;
  source: ManagerTourRowSource;
  sourceId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  propertyTitle: string;
  propertyId?: string;
  roomLabel?: string;
  whenLabel: string;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
  statusLabel: string;
  notes?: string;
  bucket: ManagerTourBucketId;
};

const PAST_GRACE_MS = 30 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

function isUpcomingEnd(endMs: number): boolean {
  return endMs >= nowMs() - PAST_GRACE_MS;
}

function buildFilter(
  viewerUserId: string,
  propertyIds: string[],
  peers: PropertyCalendarPeer[],
): ScheduledTourFilter {
  return {
    viewerUserId,
    propertyId: null,
    propertyIds: propertyIds.length ? propertyIds : undefined,
    peers,
  };
}

function inquiryRows(filter: ScheduledTourFilter): ManagerTourRow[] {
  return readPartnerInquiries()
    .filter((row) => row.kind === "tour")
    .flatMap((row) => {
      if (row.status === "pending") {
        if (!tourInquiryVisibleToViewer(row, filter)) return [];
        return getPartnerInquiryWindows(row).map((window, index) => {
          const startMs = Date.parse(window.start);
          const endMs = Date.parse(window.end);
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
          return {
            id: `inquiry-${row.id}-${index}`,
            source: "inquiry" as const,
            sourceId: row.id,
            guestName: row.name?.trim() || "Prospect",
            guestEmail: row.email?.trim() ?? "",
            guestPhone: row.phone?.trim() ?? "",
            propertyTitle: row.propertyTitle?.trim() || "Property",
            propertyId: row.propertyId,
            roomLabel: row.roomLabel,
            whenLabel: formatRangeLabel(window.start, window.end),
            startIso: window.start,
            endIso: window.end,
            startMs,
            endMs,
            statusLabel: "Pending",
            notes: row.notes,
            bucket: "pending" as const,
          };
        });
      }

      if (row.status === "declined" && row.managerUserId === filter.viewerUserId) {
        const window = getPartnerInquiryWindows(row)[0];
        if (!window) return [];
        const startMs = Date.parse(window.start);
        const endMs = Date.parse(window.end);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
        return [
          {
            id: `declined-${row.id}`,
            source: "inquiry" as const,
            sourceId: row.id,
            guestName: row.name?.trim() || "Prospect",
            guestEmail: row.email?.trim() ?? "",
            guestPhone: row.phone?.trim() ?? "",
            propertyTitle: row.propertyTitle?.trim() || "Property",
            propertyId: row.propertyId,
            roomLabel: row.roomLabel,
            whenLabel: formatRangeLabel(window.start, window.end),
            startIso: window.start,
            endIso: window.end,
            startMs,
            endMs,
            statusLabel: "Declined",
            notes: row.notes,
            bucket: "past" as const,
          },
        ];
      }

      return [];
    })
    .filter((row): row is ManagerTourRow => Boolean(row));
}

function plannedRows(filter: ScheduledTourFilter): ManagerTourRow[] {
  return readAllPlannedEvents()
    .filter((event) => event.kind === "tour")
    .filter((event) => plannedTourVisibleToViewer(event, filter))
    .map((event) => plannedRow(event))
    .filter((row): row is ManagerTourRow => Boolean(row));
}

function plannedRow(event: PlannedEvent): ManagerTourRow | null {
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const upcoming = isUpcomingEnd(endMs);
  return {
    id: `planned-${event.id}`,
    source: "planned",
    sourceId: event.id,
    guestName: event.attendeeName?.trim() || "Confirmed tour",
    guestEmail: event.attendeeEmail?.trim() ?? "",
    guestPhone: event.attendeePhone?.trim() ?? "",
    propertyTitle: event.propertyTitle?.trim() || "Property",
    propertyId: event.propertyId,
    roomLabel: event.roomLabel,
    whenLabel: formatRangeLabel(event.start, event.end),
    startIso: event.start,
    endIso: event.end,
    startMs,
    endMs,
    statusLabel: "Confirmed",
    notes: event.notes,
    bucket: upcoming ? "upcoming" : "past",
  };
}

export function buildManagerTourRows(input: {
  viewerUserId: string;
  propertyIds: string[];
}): ManagerTourRow[] {
  const peersByProperty = new Map<string, PropertyCalendarPeer[]>();
  for (const propertyId of input.propertyIds) {
    peersByProperty.set(propertyId, listPropertyCalendarPeers(input.viewerUserId, propertyId));
  }
  const peers = [...new Map(
    [...peersByProperty.values()].flat().map((peer) => [peer.userId, peer] as const),
  ).values()];

  const filter = buildFilter(input.viewerUserId, input.propertyIds, peers);
  const rows = [...inquiryRows(filter), ...plannedRows(filter)];
  return rows.sort((a, b) => b.startMs - a.startMs);
}

export function countManagerTourRowsByBucket(rows: ManagerTourRow[]): Record<ManagerTourBucketId, number> {
  return rows.reduce(
    (acc, row) => {
      acc[row.bucket] += 1;
      return acc;
    },
    { pending: 0, upcoming: 0, past: 0 } satisfies Record<ManagerTourBucketId, number>,
  );
}

export function filterManagerTourRows(
  rows: ManagerTourRow[],
  bucket: ManagerTourBucketId,
  propertyFilters: string[],
  searchQuery: string,
): ManagerTourRow[] {
  const q = searchQuery.trim().toLowerCase();
  return rows.filter((row) => {
    if (row.bucket !== bucket) return false;
    if (propertyFilters.length > 0) {
      const propertyId = row.propertyId?.trim();
      if (!propertyId || !propertyFilters.includes(propertyId)) return false;
    }
    if (!q) return true;
    const hay = [row.guestName, row.guestEmail, row.propertyTitle, row.roomLabel, row.whenLabel, row.statusLabel]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
