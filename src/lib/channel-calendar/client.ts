"use client";

import { PORTAL_READ_TIMEOUT_MS, fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import type {
  ChannelCalendarConnectionPublic,
  ChannelCalendarProvider,
  ManagerChannelBookingProperty,
} from "@/lib/channel-calendar/types";

export async function fetchRoomExportCalendarUrl(input: {
  propertyId: string;
  roomId: string;
  roomLabel?: string;
  /** The site the link is pasted into; "other" is a link that carries every channel's bookings. */
  provider?: ChannelCalendarProvider | "other";
}): Promise<string> {
  const params = new URLSearchParams({
    propertyId: input.propertyId,
    roomId: input.roomId,
  });
  if (input.provider) params.set("provider", input.provider);
  if (input.roomLabel?.trim()) params.set("roomLabel", input.roomLabel.trim());
  const res = await fetch(`/api/portal/channel-calendar/connections?${params}`, {
    credentials: "include",
  });
  const data = (await res.json()) as { exportUrl?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load export calendar.");
  if (!data.exportUrl?.trim()) throw new Error("Could not load export calendar.");
  return data.exportUrl;
}

export async function fetchChannelCalendarConnections(
  propertyId: string,
): Promise<ChannelCalendarConnectionPublic[]> {
  const res = await fetch(
    `/api/portal/channel-calendar/connections?propertyId=${encodeURIComponent(propertyId)}`,
    { credentials: "include" },
  );
  const data = (await res.json()) as { connections?: ChannelCalendarConnectionPublic[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load channel calendars.");
  return data.connections ?? [];
}

/** The subset of these properties the caller may link, unlink and sync calendars on (Calendar module at edit). */
export async function fetchWritableChannelCalendarPropertyIds(propertyIds: string[]): Promise<string[]> {
  const ids = propertyIds.filter(Boolean);
  if (ids.length === 0) return [];
  const res = await fetch(
    `/api/portal/channel-calendar/connections?writableFor=${encodeURIComponent(ids.join(","))}`,
    { credentials: "include" },
  );
  const data = (await res.json()) as { writablePropertyIds?: string[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not check calendar access.");
  return data.writablePropertyIds ?? [];
}

export async function saveChannelCalendarConnection(input: {
  propertyId: string;
  roomId: string;
  provider: ChannelCalendarProvider;
  label?: string | null;
  importUrl?: string | null;
}): Promise<ChannelCalendarConnectionPublic> {
  const res = await fetch(`/api/portal/channel-calendar/connections`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { connection?: ChannelCalendarConnectionPublic; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not save connection.");
  if (!data.connection) throw new Error("Could not save connection.");
  return data.connection;
}

export async function deleteChannelCalendarConnection(connectionId: string): Promise<void> {
  const res = await fetch(
    `/api/portal/channel-calendar/connections?id=${encodeURIComponent(connectionId)}`,
    { method: "DELETE", credentials: "include" },
  );
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not remove connection.");
}

export async function syncAllChannelCalendarConnections(
  propertyIds: string[],
): Promise<{ synced: number; failed: number }> {
  const res = await fetch(`/api/portal/channel-calendar/sync-all`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ propertyIds }),
  });
  const data = (await res.json()) as { synced?: number; failed?: number; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Sync failed.");
  return { synced: data.synced ?? 0, failed: data.failed ?? 0 };
}

export async function syncChannelCalendarConnection(
  connectionId: string,
): Promise<ChannelCalendarConnectionPublic> {
  const res = await fetch(`/api/portal/channel-calendar/sync`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId }),
  });
  const data = (await res.json()) as { connection?: ChannelCalendarConnectionPublic; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Sync failed.");
  if (!data.connection) throw new Error("Sync failed.");
  return data.connection;
}

export type OccupancySnapshotResponse = {
  days: Array<{
    dayKey: string;
    occupied: number;
    total: number;
    checkIns: number;
    checkOuts: number;
    houses?: Array<{
      propertyId: string;
      occupied: number;
      total: number;
      checkIns: number;
      checkOuts: number;
    }>;
  }>;
  stays?: unknown[];
  version?: string;
};

export async function fetchOccupancySnapshot(input: {
  propertyIds: string[];
  from: string;
  to: string;
}): Promise<OccupancySnapshotResponse> {
  const params = new URLSearchParams({
    propertyIds: input.propertyIds.join(","),
    from: input.from,
    to: input.to,
  });
  const res = await fetchWithTimeout(`/api/portal/occupancy?${params}`, { credentials: "include" }, PORTAL_READ_TIMEOUT_MS);
  const data = (await res.json()) as OccupancySnapshotResponse & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load occupancy.");
  return data;
}

export async function fetchManagerChannelBookings(
  propertyIds: string[],
  opts: { slim?: boolean } = {},
): Promise<ManagerChannelBookingProperty[]> {
  const ids = propertyIds.filter(Boolean);
  const params = new URLSearchParams();
  if (ids.length > 0) params.set("propertyIds", ids.join(","));
  if (opts.slim) params.set("slim", "1");
  const query = params.size > 0 ? `?${params}` : "";
  const res = await fetchWithTimeout(
    `/api/portal/channel-calendar/bookings${query}`,
    { credentials: "include" },
    PORTAL_READ_TIMEOUT_MS,
  );
  const data = (await res.json()) as {
    properties?: ManagerChannelBookingProperty[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "Could not load bookings.");
  return data.properties ?? [];
}

async function postChannelStayTombstone(
  action: "remove" | "restore",
  input: { connectionId: string; sourceUid: string; start?: string; end?: string },
): Promise<void> {
  const res = await fetch("/api/portal/channel-calendar/stay-tombstones", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...input }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? (action === "remove" ? "Could not remove that stay." : "Could not restore that stay."));
}

/** Remove stay — leaves a tombstone so the next sync does not bring the reservation back (C2-AB7). */
export function removeChannelStay(input: { connectionId: string; sourceUid: string; start?: string; end?: string }): Promise<void> {
  return postChannelStayTombstone("remove", input);
}

/** Undo for Remove stay. */
export function restoreChannelStay(input: { connectionId: string; sourceUid: string; start?: string; end?: string }): Promise<void> {
  return postChannelStayTombstone("restore", input);
}

/** Save the guest name a manager types for a channel stay (empty clears it). */
export async function saveChannelStayGuestName(input: { connectionId: string; sourceUid: string; guestName: string }): Promise<string> {
  const res = await fetch("/api/portal/channel-calendar/stay-details", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; guestName?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not save the guest name.");
  return data.guestName ?? "";
}

export type ChannelStayDetailsInput = {
  connectionId: string;
  sourceUid: string;
  /**
   * The RAW imported range's dates. Airbnb gives every host block on a feed the same UID, so a
   * block's note is keyed on the UID plus these; a reservation needs neither.
   */
  start?: string;
  end?: string;
  /** Omitted fields are left as they are; blank / null clears. */
  guestName?: string;
  guestPhone?: string;
  notes?: string;
  nightlyCents?: number | null;
  payoutCents?: number | null;
  /** YYYY-MM-DD or ISO; null clears. */
  paidAt?: string | null;
};

/** Save the name, phone and Airbnb money for a channel stay in one request. */
export async function saveChannelStayDetailsClient(input: ChannelStayDetailsInput): Promise<void> {
  const res = await fetch("/api/portal/channel-calendar/stay-details", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not save the booking details.");
}

export type AirbnbPayoutRow = {
  id: string;
  connectionId: string;
  sourceUid: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  guestLabel: string;
  start: string;
  end: string;
  payoutCents: number;
  paidAt: string | null;
  /** Key of the booking record page. */
  bookingKey: string;
};

export async function fetchAirbnbPayouts(): Promise<AirbnbPayoutRow[]> {
  const res = await fetchWithTimeout("/api/portal/channel-calendar/payouts", { credentials: "include" }, PORTAL_READ_TIMEOUT_MS);
  const data = (await res.json().catch(() => ({}))) as { payouts?: AirbnbPayoutRow[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load Airbnb payouts.");
  return data.payouts ?? [];
}

export type ValidateChannelImportResult = { ok: true; eventCount: number } | { ok: false; error: string };

/** Checks an "Other calendar" link on the server (public host, answers with a calendar) before it is saved. */
export async function validateChannelImportUrl(url: string): Promise<ValidateChannelImportResult> {
  const res = await fetchWithTimeout(
    "/api/portal/channel-calendar/validate",
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
    VALIDATE_CHANNEL_IMPORT_TIMEOUT_MS,
  );
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; eventCount?: number; error?: string };
  if (res.status === 429) return { ok: false, error: "Too many checks. Wait a minute and try again." };
  if (data.ok) return { ok: true, eventCount: data.eventCount ?? 0 };
  return { ok: false, error: data.error ?? "Could not check that link." };
}

/** The server gives up on a feed after 6s; the browser waits a beat longer for the answer. */
const VALIDATE_CHANNEL_IMPORT_TIMEOUT_MS = 8_000;
