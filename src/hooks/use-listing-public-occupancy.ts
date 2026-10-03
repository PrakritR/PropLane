"use client";

import { useEffect, useState } from "react";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

export function useListingPublicOccupancy(propertyId: string | null | undefined): {
  rooms: PublicRoomOccupancy[];
  loading: boolean;
} {
  const [rooms, setRooms] = useState<PublicRoomOccupancy[]>([]);
  const [loading, setLoading] = useState(Boolean(propertyId?.trim()));

  useEffect(() => {
    const id = propertyId?.trim();
    if (!id) {
      setRooms([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetch("/api/public/approved-room-occupancy")
      .then((res) => (res.ok ? res.json() : { rooms: [] }))
      .then((payload: { rooms?: PublicRoomOccupancy[] }) => {
        if (cancelled) return;
        const all = payload.rooms ?? [];
        setRooms(all.filter((row) => row.roomChoice.startsWith(`${id}::`) || row.roomChoice.startsWith(`${id}:`)));
      })
      .catch(() => {
        if (!cancelled) setRooms([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  return { rooms, loading };
}
