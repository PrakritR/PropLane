"use client";

import type {
  ChannelCalendarConnectionPublic,
  ChannelCalendarProvider,
  ManagerChannelBookingProperty,
} from "@/lib/channel-calendar/types";

function apiOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export async function fetchChannelCalendarConnections(
  propertyId: string,
): Promise<ChannelCalendarConnectionPublic[]> {
  const origin = encodeURIComponent(apiOrigin());
  const res = await fetch(
    `/api/portal/channel-calendar/connections?propertyId=${encodeURIComponent(propertyId)}&origin=${origin}`,
    { credentials: "include" },
  );
  const data = (await res.json()) as { connections?: ChannelCalendarConnectionPublic[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load channel calendars.");
  return data.connections ?? [];
}

export async function saveChannelCalendarConnection(input: {
  propertyId: string;
  roomId: string;
  provider: ChannelCalendarProvider;
  label?: string | null;
  importUrl?: string | null;
}): Promise<ChannelCalendarConnectionPublic> {
  const origin = encodeURIComponent(apiOrigin());
  const res = await fetch(`/api/portal/channel-calendar/connections?origin=${origin}`, {
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
  const origin = encodeURIComponent(apiOrigin());
  const res = await fetch(`/api/portal/channel-calendar/sync?origin=${origin}`, {
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
  const res = await fetch(`/api/portal/occupancy?${params}`, { credentials: "include" });
  const data = (await res.json()) as OccupancySnapshotResponse & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load occupancy.");
  return data;
}

export async function fetchManagerChannelBookings(
  propertyIds: string[],
): Promise<ManagerChannelBookingProperty[]> {
  const ids = propertyIds.filter(Boolean);
  const query =
    ids.length > 0
      ? `?propertyIds=${encodeURIComponent(ids.join(","))}`
      : "";
  const res = await fetch(`/api/portal/channel-calendar/bookings${query}`, {
    credentials: "include",
  });
  const data = (await res.json()) as {
    properties?: ManagerChannelBookingProperty[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "Could not load bookings.");
  return data.properties ?? [];
}
