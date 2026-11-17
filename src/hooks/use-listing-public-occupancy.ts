"use client";

import { useEffect, useState } from "react";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { sharedGet } from "@/lib/shared-get-cache";

export function useListingPublicOccupancy(propertyId: string | null | undefined): {
  rooms: PublicRoomOccupancy[];
  loading: boolean;
  /** The occupancy request failed: callers keep the room's static label instead of claiming a date. */
  failed: boolean;
} {
  return useListingsPublicOccupancy(propertyId?.trim() ? [propertyId.trim()] : []);
}

/**
 * The same one read for SEVERAL houses (a multi-listing share): rows for every id asked about, from
 * the one `sharedGet`. Callers still pick a house's rows by id (`findPublicRoomOccupancy`), so a
 * house never reads another's spans.
 */
export function useListingsPublicOccupancy(propertyIds: readonly string[]): {
  rooms: PublicRoomOccupancy[];
  loading: boolean;
  failed: boolean;
} {
  const key = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))].sort().join(",");
  const [rooms, setRooms] = useState<PublicRoomOccupancy[]>([]);
  const [loading, setLoading] = useState(Boolean(key));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ids = key.split(",").filter(Boolean);
    if (!ids.length) {
      setRooms([]);
      setFailed(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // The listing hero and the room tables both read this on one page: one request through sharedGet.
    void sharedGet("/api/public/approved-room-occupancy")
      .then((read) => {
        if (cancelled) return;
        setFailed(!read.ok);
        const all = (read.ok ? (read.data as { rooms?: PublicRoomOccupancy[] } | null)?.rooms : null) ?? [];
        setRooms(
          all.filter((row) => ids.some((id) => row.roomChoice.startsWith(`${id}::`) || row.roomChoice.startsWith(`${id}:`))),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setRooms([]);
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { rooms, loading, failed };
}
