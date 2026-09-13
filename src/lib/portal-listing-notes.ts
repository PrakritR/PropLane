/** Portal-only notes store — shared between the Properties panel and move-in resolver. */

import type { HouseInfoV1 } from "@/lib/house-info";

const PORTAL_NOTES_KEY = "axis_portal_notes_v1";

export type PortalRoomNote = {
  name?: string;
  detail?: string;
  amenitiesText?: string;
  furnishing?: string;
  availability?: string;
  utilitiesEstimate?: string;
  moveInAvailableDate?: string;
  moveInInstructions?: string;
  monthlyRent?: number;
};

export type PortalListingNote = {
  tagline?: string;
  houseOverview?: string;
  amenitiesText?: string;
  houseRulesText?: string;
  houseDescription?: string;
  /** Resident-facing general house info (codes, tips) — stored on submission, carried here only as draft state. */
  generalHouseInfo?: string;
  /** Structured resident-facing house details — stored on submission, carried here only as draft state. */
  houseInfo?: HouseInfoV1;
  /** @deprecated Superseded by `houseInfo.wifi.network`. */
  wifiNetworkName?: string;
  /** @deprecated Superseded by `houseInfo.wifi.password`. */
  wifiPassword?: string;
  rooms?: Record<string, PortalRoomNote>;
};

type PortalNotesStore = Record<string, PortalListingNote>;

export function readPortalNotesStore(): PortalNotesStore {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(PORTAL_NOTES_KEY) ?? "{}") as PortalNotesStore;
  } catch {
    return {};
  }
}

export function getPortalListingNote(noteKey: string): PortalListingNote {
  return readPortalNotesStore()[noteKey] ?? {};
}

export function savePortalListingNote(noteKey: string, patch: Partial<PortalListingNote>): void {
  if (typeof window === "undefined") return;
  const store = readPortalNotesStore();
  store[noteKey] = { ...(store[noteKey] ?? {}), ...patch };
  localStorage.setItem(PORTAL_NOTES_KEY, JSON.stringify(store));
}

export function savePortalRoomNote(noteKey: string, roomId: string, patch: PortalRoomNote): void {
  if (typeof window === "undefined") return;
  const store = readPortalNotesStore();
  const listing = store[noteKey] ?? {};
  listing.rooms = { ...(listing.rooms ?? {}), [roomId]: { ...(listing.rooms?.[roomId] ?? {}), ...patch } };
  store[noteKey] = listing;
  localStorage.setItem(PORTAL_NOTES_KEY, JSON.stringify(store));
}

/** Get move-in instructions for a specific room from portal notes. Returns null if none set. */
export function getPortalRoomMoveInInstructions(
  managerUserId: string,
  propertyId: string,
  listingRoomId: string,
): string | null {
  if (!managerUserId || !propertyId || !listingRoomId) return null;
  const noteKey = `${managerUserId}:${propertyId}`;
  const note = getPortalListingNote(noteKey);
  return note.rooms?.[listingRoomId]?.moveInInstructions?.trim() || null;
}
