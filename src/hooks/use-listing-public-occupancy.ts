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
  const [rooms, setRooms] = useState<PublicRoomOccupancy[]>([]);
  const [loading, setLoading] = useState(Boolean(propertyId?.trim()));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const id = propertyId?.trim();
    if (!id) {
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
        setRooms(all.filter((row) => row.roomChoice.startsWith(`${id}::`) || row.roomChoice.startsWith(`${id}:`)));
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
  }, [propertyId]);

  return { rooms, loading, failed };
}
