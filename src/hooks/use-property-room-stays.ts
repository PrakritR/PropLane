"use client";

import { useEffect, useState } from "react";

import { pacificTodayKey } from "@/lib/room-availability-range";
import { sharedGet } from "@/lib/shared-get-cache";
import type { RoomOccupancyStay } from "@/lib/property-record-row-facts";

/**
 * One house's stays from the manager occupancy snapshot (residents, channel stays, blocks), through
 * the shared GET cache. Null until answered and after a failed read, so a row falls back to what
 * the listing itself says rather than claiming a room is free.
 */
export function usePropertyRoomStays(propertyId: string, enabled = true): RoomOccupancyStay[] | null {
  const [read, setRead] = useState<{ propertyId: string; stays: RoomOccupancyStay[] | null }>({ propertyId: "", stays: null });
  useEffect(() => {
    if (!enabled || !propertyId.trim()) return;
    let cancelled = false;
    const today = pacificTodayKey();
    const params = new URLSearchParams({ propertyIds: propertyId.trim(), from: today, to: today });
    void sharedGet(`/api/portal/occupancy?${params}`).then((result) => {
      if (cancelled) return;
      const body = result.ok ? (result.data as { stays?: unknown; days?: Array<{ houses?: Array<{ propertyId?: string }> }> } | null) : null;
      const raw = body?.stays;
      // The server answers only for houses this viewer may read the calendar of; an unanswered house is unknown, not empty.
      const answered = body?.days?.[0]?.houses?.some((house) => house.propertyId === propertyId.trim()) === true;
      if (!Array.isArray(raw) || !answered) {
        setRead({ propertyId, stays: null });
        return;
      }
      const stays: RoomOccupancyStay[] = [];
      for (const item of raw) {
        const stay = item as Partial<RoomOccupancyStay> & { propertyId?: string };
        if (stay.propertyId !== propertyId.trim() || !stay.start || !stay.end) continue;
        stays.push({
          roomId: String(stay.roomId ?? ""),
          start: stay.start,
          end: stay.end,
          ...(stay.openEnded ? { openEnded: true } : {}),
          ...(stay.echoable ? { echoable: true } : {}),
        });
      }
      setRead({ propertyId, stays });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, propertyId]);
  return read.propertyId === propertyId ? read.stays : null;
}
