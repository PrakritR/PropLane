"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import {
  airbnbBookingEntries,
  applicationHoldEntries,
  leaseBookingEntriesForProperties,
  openEndedBookingHorizonKey,
  roomBlockEntries,
  type PropertyBookingEntry,
  type RoomDateBlock,
} from "@/lib/channel-calendar/property-bookings";
import { ROOM_DATE_BLOCKS_CHANGED, fetchRoomDateBlocks } from "@/lib/channel-calendar/room-date-blocks";
import { useLeasePipelineRows } from "@/hooks/use-lease-pipeline-rows";
import { getPropertyById, isEntireHomeProperty } from "@/lib/rental-application/data";
import { leaseIsFullyExecuted } from "@/lib/lease-pipeline-storage";
import {
  MANAGER_APPLICATIONS_EVENT,
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import type { DemoApplicantRow } from "@/data/demo-portal";

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
  const [applicationRows, setApplicationRows] = useState<DemoApplicantRow[]>([]);
  const [blocks, setBlocks] = useState<RoomDateBlock[]>([]);

  const leaseRows = useLeasePipelineRows(userId, { enabled: Boolean(userId) });

  // Approved applications hold a room before the lease is signed.
  useEffect(() => {
    if (!userId) {
      setApplicationRows([]);
      return;
    }
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setApplicationRows(readManagerApplicationRows());
    };
    sync();
    void syncManagerApplicationsFromServer({ managerUserId: userId }).then(sync);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, sync);
    return () => {
      cancelled = true;
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, sync);
    };
  }, [userId, refreshSignal]);

  // Explicit closed dates, kept on the server so every device sees them.
  useEffect(() => {
    if (!userId) {
      setBlocks([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetchRoomDateBlocks()
        .then((rows) => {
          if (!cancelled) setBlocks(rows);
        })
        .catch(() => {
          if (!cancelled) setBlocks([]);
        });
    void load();
    const onChange = () => void load();
    window.addEventListener(ROOM_DATE_BLOCKS_CHANGED, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(ROOM_DATE_BLOCKS_CHANGED, onChange);
    };
  }, [userId, refreshSignal]);

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

  const holdEntries = useMemo<PropertyBookingEntry[]>(() => {
    if (!userId) return [];
    const scoped = new Set(propertyIds);
    // Same two-way match `applicationRowForLease` uses: the Axis id binds
    // exactly; email + property covers a lease whose id was never stamped.
    const leasedIds = new Set<string>();
    const leasedPeople = new Set<string>();
    for (const row of leaseRows) {
      if (!leaseIsFullyExecuted(row)) continue;
      const axisId = normalizeApplicationAxisId(row.axisId ?? "");
      if (axisId) leasedIds.add(axisId);
      const email = row.residentEmail?.trim().toLowerCase();
      if (email) leasedPeople.add(`${email}|${(row.propertyId ?? "").trim()}`);
    }
    return applicationHoldEntries(applicationRows, {
      properties: propertyOptions
        .filter((property) => scoped.has(property.id))
        .map((property) => ({
          id: property.id,
          label: property.label,
          entireHomeListing: isEntireHomeProperty(property.id),
        })),
      roomLabelForId: (propertyId, roomId) =>
        bookingsRoomLabels.get(`${propertyId}:${roomId}`) ?? "Room",
      isLeased: (row) => {
        if (leasedIds.has(normalizeApplicationAxisId(row.id))) return true;
        const email = row.email?.trim().toLowerCase();
        const propertyId = (row.assignedPropertyId ?? row.propertyId ?? "").trim();
        return Boolean(email) && leasedPeople.has(`${email}|${propertyId}`);
      },
      openEndedHorizonKey: openEndedBookingHorizonKey(),
    });
  }, [userId, applicationRows, leaseRows, propertyOptions, propertyIds, bookingsRoomLabels]);

  const blockEntries = useMemo<PropertyBookingEntry[]>(() => {
    const scoped = new Set(propertyIds);
    const labels = new Map(propertyOptions.map((property) => [property.id, property.label]));
    return roomBlockEntries(
      blocks.filter((block) => scoped.has(block.propertyId)),
      {
        propertyLabelForId: (propertyId) => labels.get(propertyId) ?? propertyId,
        roomLabelForId: (propertyId, roomId) => bookingsRoomLabels.get(`${propertyId}:${roomId}`) ?? "Room",
      },
    );
  }, [blocks, propertyOptions, propertyIds, bookingsRoomLabels]);

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
    () => [...airbnbEntries, ...leaseEntries, ...holdEntries, ...blockEntries],
    [airbnbEntries, leaseEntries, holdEntries, blockEntries],
  );

  return { entries, loading, reloadAirbnb, blocks };
}
