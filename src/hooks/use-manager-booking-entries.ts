"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import {
  airbnbBookingEntries,
  leaseBookingEntriesForProperties,
  openEndedBookingHorizonKey,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { useLeasePipelineRows } from "@/hooks/use-lease-pipeline-rows";
import { getPropertyById, isEntireHomeProperty } from "@/lib/rental-application/data";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";

export function useManagerBookingEntries({
  userId,
  propertyIds,
  propertyOptions,
  propertyTick,
  refreshSignal = 0,
  showToast,
}: {
  userId: string | null;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  propertyTick: number;
  refreshSignal?: number;
  showToast: (message: string) => void;
}) {
  const [airbnbEntries, setAirbnbEntries] = useState<PropertyBookingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const leaseRows = useLeasePipelineRows(userId, { enabled: Boolean(userId) });

  const bookingsRoomLabels = useMemo(() => {
    const labels = new Map<string, string>();
    void propertyTick;
    for (const propertyId of propertyIds) {
      const submission = getPropertyById(propertyId)?.listingSubmission;
      if (submission?.v !== 1) continue;
      normalizeManagerListingSubmissionV1(submission).rooms.forEach((room, index) => {
        labels.set(`${propertyId}:${room.id}`, room.name?.trim() || `Room ${index + 1}`);
      });
    }
    return labels;
  }, [propertyIds, propertyTick]);

  const leaseEntries = useMemo<PropertyBookingEntry[]>(() => {
    if (!userId) return [];
    const scoped = new Set(propertyIds);
    return leaseBookingEntriesForProperties(leaseRows, {
      properties: propertyOptions
        .filter((property) => scoped.has(property.id))
        .map((property) => ({
          id: property.id,
          label: property.label,
          entireHomeListing: isEntireHomeProperty(property.id),
        })),
      roomLabelForId: (propertyId, roomId) =>
        bookingsRoomLabels.get(`${propertyId}:${roomId}`) ?? "Room",
      openEndedHorizonKey: openEndedBookingHorizonKey(),
    });
  }, [userId, leaseRows, propertyOptions, propertyIds, bookingsRoomLabels]);

  const reloadAirbnb = useCallback(async () => {
    if (propertyIds.length === 0) {
      setAirbnbEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await fetchManagerChannelBookings(propertyIds);
      setAirbnbEntries(airbnbBookingEntries(rows));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load bookings.");
      setAirbnbEntries([]);
    } finally {
      setLoading(false);
    }
  }, [propertyIds, showToast]);

  useEffect(() => {
    void reloadAirbnb();
  }, [reloadAirbnb, refreshSignal]);

  const entries = useMemo(
    () => [...airbnbEntries, ...leaseEntries],
    [airbnbEntries, leaseEntries],
  );

  return { entries, loading, reloadAirbnb };
}
