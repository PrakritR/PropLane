"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchManagerChannelBookings, fetchOccupancySnapshot } from "@/lib/channel-calendar/client";
import type { OccupancyDayLookup } from "@/lib/channel-calendar/bookings-occupancy";
import type { OccupancyDayCell } from "@/lib/occupancy/snapshot";
import {
  airbnbBookingEntries,
  applicationHoldEntries,
  importedChannelStayEntries,
  isImportedChannelBlock,
  leaseBookingEntriesForProperties,
  openEndedBookingHorizonKey,
  roomBlockEntries,
  type PropertyBookingEntry,
  type RoomDateBlock,
} from "@/lib/channel-calendar/property-bookings";
import { ROOM_DATE_BLOCKS_CHANGED, fetchRoomDateBlocks } from "@/lib/channel-calendar/room-date-blocks";
import {
  blockDatesResidentOptions,
  type BlockDatesResidentOption,
} from "@/lib/channel-calendar/block-dates-residents";
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

/** Calendar / day sheet sources: residents + channel + manager Add booking blocks. */
const BOOKING_CALENDAR_SOURCES = new Set<PropertyBookingEntry["source"]>([
  "proplane",
  "hold",
  "airbnb",
  "booking_com",
  "block",
]);

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
  const [occupancyDays, setOccupancyDays] = useState<OccupancyDayLookup>({ overall: {}, houses: {} });
  const [channelReady, setChannelReady] = useState(false);
  const [applicationRows, setApplicationRows] = useState<DemoApplicantRow[]>([]);
  const [applicationsReady, setApplicationsReady] = useState(false);
  const [blocks, setBlocks] = useState<RoomDateBlock[]>([]);
  const [blocksReady, setBlocksReady] = useState(false);

  const { rows: leaseRows, ready: leasesReady } = useLeasePipelineRows(userId, {
    enabled: Boolean(userId),
  });

  useEffect(() => {
    setApplicationsReady(false);
    setBlocksReady(false);
  }, [userId]);

  // Approved applications hold a room before the lease is signed.
  useEffect(() => {
    if (!userId) {
      setApplicationRows([]);
      setApplicationsReady(true);
      return;
    }
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setApplicationRows(readManagerApplicationRows());
    };
    sync();
    void syncManagerApplicationsFromServer({ managerUserId: userId })
      .then(sync)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setApplicationsReady(true);
      });
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
      setBlocksReady(true);
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
        })
        .finally(() => {
          if (!cancelled) setBlocksReady(true);
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
      blocks.filter((block) => scoped.has(block.propertyId) && !isImportedChannelBlock(block)),
      {
        propertyLabelForId: (propertyId) => labels.get(propertyId) ?? propertyId,
        roomLabelForId: (propertyId, roomId) => bookingsRoomLabels.get(`${propertyId}:${roomId}`) ?? "Room",
      },
    );
  }, [blocks, propertyOptions, propertyIds, bookingsRoomLabels]);

  // Who "Block dates" can hold a room for — the whole directory, not just the
  // houses in the current filter: a manager holding Room 1 for someone moving
  // over from another house is exactly the case a hold is for.
  const residentOptions = useMemo<BlockDatesResidentOption[]>(() => {
    if (!userId) return [];
    const labels = new Map(propertyOptions.map((property) => [property.id, property.label]));
    return blockDatesResidentOptions(leaseRows, {
      propertyLabelForId: (propertyId) => labels.get(propertyId) ?? "",
      roomLabelForId: (propertyId, roomId) => bookingsRoomLabels.get(`${propertyId}:${roomId}`) ?? "",
    });
  }, [userId, leaseRows, propertyOptions, bookingsRoomLabels]);

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

  const occupancyWindow = useMemo(() => {
    const now = new Date();
    const from = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    const to = new Date(now.getFullYear() + 2, now.getMonth() + 1, 0);
    const ymd = (value: Date) =>
      `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    return { from: ymd(from), to: ymd(to) };
  }, []);

  const reloadAirbnb = useCallback(async () => {
    const ids = propertyIdsKey ? propertyIdsKey.split("\u0000") : [];
    if (ids.length === 0) {
      setAirbnbEntries([]);
      setOccupancyDays({ overall: {}, houses: {} });
      setChannelReady(true);
      return;
    }
    try {
      const [bookingsResult, snapshotResult] = await Promise.allSettled([
        fetchManagerChannelBookings(ids),
        fetchOccupancySnapshot({ propertyIds: ids, from: occupancyWindow.from, to: occupancyWindow.to }),
      ]);
      if (bookingsResult.status === "fulfilled") {
        setAirbnbEntries(airbnbBookingEntries(bookingsResult.value));
      } else {
        showToast(
          bookingsResult.reason instanceof Error ? bookingsResult.reason.message : "Could not load bookings.",
        );
        setAirbnbEntries([]);
      }
      if (snapshotResult.status === "fulfilled") {
        const overall: Record<string, OccupancyDayCell> = {};
        const houses: Record<string, OccupancyDayCell> = {};
        for (const day of snapshotResult.value.days ?? []) {
          overall[day.dayKey] = {
            occupied: day.occupied,
            total: day.total,
            checkIns: day.checkIns,
            checkOuts: day.checkOuts,
          };
          for (const house of day.houses ?? []) {
            houses[`${house.propertyId}:${day.dayKey}`] = {
              occupied: house.occupied,
              total: house.total,
              checkIns: house.checkIns,
              checkOuts: house.checkOuts,
            };
          }
        }
        setOccupancyDays({ overall, houses });
      }
    } finally {
      setChannelReady(true);
    }
  }, [propertyIdsKey, occupancyWindow, showToast]);

  useEffect(() => {
    void reloadAirbnb();
  }, [reloadAirbnb, refreshSignal]);

  /**
   * Wait until leases, applications, blocks, and channel syncs have each
   * settled once. Later refreshes keep the stays already on screen — only the
   * first coordinated load draws skeletons.
   */
  const loading = !channelReady || !leasesReady || !applicationsReady || !blocksReady;

  const importedAirbnbEntries = useMemo<PropertyBookingEntry[]>(() => {
    const scoped = new Set(propertyIds);
    const labels = new Map(propertyOptions.map((property) => [property.id, property.label]));
    return importedChannelStayEntries(
      blocks.filter((block) => scoped.has(block.propertyId)),
      {
        propertyLabelForId: (propertyId) => labels.get(propertyId) ?? propertyId,
        roomLabelForId: (propertyId, roomId) => bookingsRoomLabels.get(`${propertyId}:${roomId}`) ?? "Room",
      },
    );
  }, [blocks, propertyOptions, propertyIds, bookingsRoomLabels]);

  const entries = useMemo(
    () =>
      [...airbnbEntries, ...importedAirbnbEntries, ...leaseEntries, ...holdEntries, ...blockEntries].filter(
        (entry) => BOOKING_CALENDAR_SOURCES.has(entry.source),
      ),
    [airbnbEntries, importedAirbnbEntries, leaseEntries, holdEntries, blockEntries],
  );

  return { entries, occupancyDays, loading, reloadAirbnb, blocks, residentOptions };
}
