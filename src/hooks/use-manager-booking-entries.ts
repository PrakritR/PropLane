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
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(true);

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

  /**
   * The fetch is keyed on WHICH houses are in scope, not on the array carrying
   * them.
   *
   * `propertyIds` is rebuilt from `buildManagerPropertyFilterOptions` every time
   * `propertyTick` bumps, and that bumps on every portfolio refresh event
   * (`MANAGER_PORTFOLIO_REFRESH_EVENTS` — the property pipeline, pro
   * relationships, `storage`, applications). A new array with identical
   * contents used to give `reloadAirbnb` a new identity, refire the effect, and
   * blank the whole list back to skeleton rows for a round trip that could only
   * ever return the same bookings.
   */
  const propertyIdsKey = useMemo(() => [...propertyIds].sort().join("\u0000"), [propertyIds]);

  const reloadAirbnb = useCallback(async () => {
    const ids = propertyIdsKey ? propertyIdsKey.split("\u0000") : [];
    if (ids.length === 0) {
      setAirbnbEntries([]);
      setLoaded(true);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      const rows = await fetchManagerChannelBookings(ids);
      setAirbnbEntries(airbnbBookingEntries(rows));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load bookings.");
      setAirbnbEntries([]);
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [propertyIdsKey, showToast]);

  useEffect(() => {
    void reloadAirbnb();
  }, [reloadAirbnb, refreshSignal]);

  /**
   * Only the FIRST load draws skeletons. A later refresh keeps the stays that
   * are already on screen — replacing a list the manager is reading with grey
   * placeholders reads as the page reloading under them.
   */
  const loading = !loaded && refreshing;

  const entries = useMemo(
    () => [...airbnbEntries, ...leaseEntries],
    [airbnbEntries, leaseEntries],
  );

  return { entries, loading, reloadAirbnb };
}
