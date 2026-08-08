"use client";

import type {
  ChannelCalendarConnectionPublic,
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
