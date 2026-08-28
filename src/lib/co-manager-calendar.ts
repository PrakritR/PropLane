/**
 * Co-manager calendar coordination: shared property peers, availability sharing, tour visibility.
 */

import {
  dateSlotKey,
  managerPropertyAvailabilityStorageKey,
  readAvailabilityDateSetForStorageKey,
  readPartnerInquiries,
  readPlannedEvents,
  slotIndexForDate,
  toLocalDateStr,
  type PartnerInquiry,
  type PlannedEvent,
} from "@/lib/demo-admin-scheduling";
import {
  readAllExtraListings,
  readAllPendingManagerProperties,
} from "@/lib/demo-property-pipeline";
import { collectLinkedPropertyIdsForModule, readLinkedListingsForUser } from "@/lib/manager-portfolio-access";
import { readProRelationships } from "@/lib/pro-relationships";

export type PropertyCalendarPeer = {
  userId: string;
  label: string;
  isSelf: boolean;
};

export type CoManagerAvailabilityOverlay = {
  userId: string;
  label: string;
  slots: Set<string>;
};

export type ScheduledTourFilter = {
  viewerUserId: string;
  /** Single-property scope (availability peers, legacy callers). */
  propertyId: string | null;
  /** When set, tours are limited to these properties (multi-select calendar filter). */
  propertyIds?: string[];
  peers: PropertyCalendarPeer[];
};

function scheduledTourPropertyIds(filter: ScheduledTourFilter): string[] | null {
  if (filter.propertyIds?.length) return filter.propertyIds;
  const single = filter.propertyId?.trim();
  return single ? [single] : null;
}

function eventMatchesScheduledTourProperty(
  eventPropertyId: string | undefined,
  filter: ScheduledTourFilter,
): boolean {
  const ids = scheduledTourPropertyIds(filter);
  if (!ids) return true;
  if (!eventPropertyId) return false;
  return ids.some((id) => samePropertyId(id, eventPropertyId));
}

export type CoManagerCalendarPeerDto = PropertyCalendarPeer & {
  sharesAvailability: boolean;
  slots: string[];
};

function safePropertyToken(propertyId: string): string {
  return propertyId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

export function samePropertyId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;
  if (left === right) return true;
  return safePropertyToken(left) === safePropertyToken(right);
}

/** All managers who share access to tours on this property (owner + linked co-managers). */
export function listPropertyCalendarPeers(viewerUserId: string, propertyId: string): PropertyCalendarPeer[] {
  const pid = propertyId.trim();
  const viewer = viewerUserId.trim();
  if (!pid || !viewer) return [];

  const peersById = new Map<string, { label: string; isSelf: boolean }>();

  const listing = readAllExtraListings().find((p) => p.id === pid);
  const pending = readAllPendingManagerProperties().find((p) => p.id === pid);
  const ownerUserId = listing?.managerUserId?.trim() || pending?.submittedByUserId?.trim() || "";

  if (ownerUserId) {
    peersById.set(ownerUserId, {
      label: ownerUserId === viewer ? "You" : "Primary manager",
      isSelf: ownerUserId === viewer,
    });
  }

  for (const rel of readProRelationships(viewer)) {
    if (!rel.assignedPropertyIds.includes(pid)) continue;
    const linkedId = rel.linkedUserId?.trim();
    if (!linkedId) continue;
    peersById.set(linkedId, {
      label: linkedId === viewer ? "You" : rel.linkedDisplayName ?? rel.linkedAxisId,
      isSelf: linkedId === viewer,
    });
  }

  for (const { ownerUserId: linkedOwner, listing: linkedListing } of readLinkedListingsForUser(viewer)) {
    if (linkedListing.id !== pid || !linkedOwner) continue;
    peersById.set(linkedOwner, {
      label: linkedOwner === viewer ? "You" : "Primary manager",
      isSelf: linkedOwner === viewer,
    });
  }

  if (ownerUserId && ownerUserId !== viewer) {
    for (const rel of readProRelationships(ownerUserId)) {
      if (!rel.assignedPropertyIds.includes(pid)) continue;
      const linkedId = rel.linkedUserId?.trim();
      if (!linkedId) continue;
      peersById.set(linkedId, {
        label: linkedId === viewer ? "You" : rel.linkedDisplayName ?? rel.linkedAxisId,
        isSelf: linkedId === viewer,
      });
    }
  }

  if (!peersById.has(viewer)) {
    peersById.set(viewer, { label: "You", isSelf: true });
  }

  return [...peersById.entries()]
    .map(([userId, meta]) => ({
      userId,
      label: meta.label,
      isSelf: meta.isSelf,
    }))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
}

export function propertyHasMultipleCalendarManagers(viewerUserId: string, propertyId: string): boolean {
  return listPropertyCalendarPeers(viewerUserId, propertyId).length > 1;
}

/** True when the manager had an open availability slot covering the tour start. */
export function managerHadAvailabilityAtSlot(
  managerUserId: string,
  propertyId: string,
  isoStart: string,
): boolean {
  const uid = managerUserId.trim();
  const pid = propertyId.trim();
  if (!uid || !pid) return false;
  const start = new Date(isoStart);
  if (Number.isNaN(start.getTime())) return false;
  const slot = slotIndexForDate(start);
  if (slot == null) return false;
  const key = dateSlotKey(toLocalDateStr(start), slot);
  const slots = readAvailabilityDateSetForStorageKey(managerPropertyAvailabilityStorageKey(uid, pid));
  return slots.has(key);
}

function viewerHasCalendarAccess(viewerUserId: string, propertyId: string): boolean {
  const pid = propertyId.trim();
  const listing = readAllExtraListings().find((p) => p.id === pid);
  if (listing?.managerUserId?.trim() === viewerUserId) return true;
  // Use the shared module helper so the empty-perms = full-access rule applies
  // (a full-access co-manager was previously denied calendar because no explicit
  // `calendar` grant was set) and both the mirror and invite cache are consulted.
  return collectLinkedPropertyIdsForModule(viewerUserId, "calendar").has(pid);
}

/** Pending tour requests are visible only to the manager who was available when the guest booked. */
export function tourInquiryVisibleToViewer(row: PartnerInquiry, filter: ScheduledTourFilter): boolean {
  if (row.kind !== "tour" || row.status !== "pending") return false;
  if (!eventMatchesScheduledTourProperty(row.propertyId, filter)) return false;
  return row.managerUserId === filter.viewerUserId;
}

/** Manager task blocks: owner only, scoped to the calendar's selected house(s). */
export function plannedTaskVisibleToViewer(event: PlannedEvent, filter: ScheduledTourFilter): boolean {
  if (event.kind !== "task") return false;
  if (event.managerUserId !== filter.viewerUserId) return false;
  if (!event.propertyId?.trim()) return true;
  return eventMatchesScheduledTourProperty(event.propertyId, filter);
}

/** Confirmed tours: assigned host always; co-manager peers only if they were available at booking time. */
export function plannedTourVisibleToViewer(event: PlannedEvent, filter: ScheduledTourFilter): boolean {
  if (event.kind !== "tour") return false;
  if (!eventMatchesScheduledTourProperty(event.propertyId, filter)) return false;
  if (event.managerUserId === filter.viewerUserId) return true;
  const eventPropertyId = event.propertyId?.trim();
  if (!eventPropertyId) return false;
  if (!viewerHasCalendarAccess(filter.viewerUserId, eventPropertyId)) return false;
  const isPeer = filter.peers.some((peer) => peer.userId === event.managerUserId && !peer.isSelf);
  if (!isPeer) return false;
  return managerHadAvailabilityAtSlot(filter.viewerUserId, eventPropertyId, event.start);
}

export function coManagerOverlaysFromPeers(
  peers: CoManagerCalendarPeerDto[],
  viewerUserId: string,
): CoManagerAvailabilityOverlay[] {
  return peers
    .filter((peer) => !peer.isSelf && peer.userId !== viewerUserId && peer.sharesAvailability && peer.slots.length > 0)
    .map((peer) => ({
      userId: peer.userId,
      label: peer.label,
      slots: new Set(peer.slots),
    }));
}

export function readVisiblePropertyTours(filter: ScheduledTourFilter): {
  inquiries: PartnerInquiry[];
  planned: PlannedEvent[];
} {
  const inquiries = readPartnerInquiries().filter((row) => tourInquiryVisibleToViewer(row, filter));
  const planned = readPlannedEvents().filter((event) => plannedTourVisibleToViewer(event, filter));
  return { inquiries, planned };
}
