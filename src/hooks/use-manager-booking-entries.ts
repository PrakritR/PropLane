"use client";

import { withoutEchoedHostBlocks } from "@/lib/channel-calendar/host-block";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PORTAL_READ_TIMEOUT_MS, withTimeout } from "@/lib/auth/fetch-with-timeout";
import { fetchManagerChannelBookings, fetchOccupancySnapshot } from "@/lib/channel-calendar/client";
import type { OccupancyDayLookup } from "@/lib/channel-calendar/bookings-occupancy";
import type { OccupancyDayCell } from "@/lib/occupancy/snapshot";
import {
  airbnbBookingEntries,
  applicationHoldEntries,
  type ApplicationHoldRow,
  importedChannelStayEntries,
  isImportedChannelBlock,
  leaseBookingEntriesForProperties,
  openEndedBookingHorizonKey,
  roomBlockEntries,
  type PropertyBookingEntry,
  type RoomDateBlock,
} from "@/lib/channel-calendar/property-bookings";
import { ROOM_DATE_BLOCKS_CHANGED, fetchRoomDateBlocks } from "@/lib/channel-calendar/room-date-blocks";
import { STAY_META_CHANGED, applyStayMeta, type StayMeta } from "@/lib/channel-calendar/stay-meta";
import { fetchStayMetas } from "@/lib/channel-calendar/stay-meta-client";
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
  syncManagerApplicationsFromServerWithStatus,
} from "@/lib/manager-applications-storage";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { directoryResidentEmailSet, isLinkedToDirectoryResident } from "@/lib/resident-directory-scope";
import type { DemoApplicantRow } from "@/data/demo-portal";

/** Calendar / day sheet sources: residents + channel + manager Add booking blocks. */
const BOOKING_CALENDAR_SOURCES = new Set<PropertyBookingEntry["source"]>([
  "proplane",
  "hold",
  "airbnb",
  "booking_com",
  "vrbo",
  "block",
]);

/** The fetches Bookings is built from; one that errors or times out is listed in `failedSources`. */
export type BookingsSourceId = "channel" | "occupancy" | "applications" | "blocks" | "leases";
type SourceStatus = "pending" | "ok" | "failed";
const BOOKINGS_SOURCE_IDS: readonly BookingsSourceId[] = ["channel", "occupancy", "applications", "blocks", "leases"];
const PENDING_SOURCES: Record<BookingsSourceId, SourceStatus> = {
  channel: "pending",
  occupancy: "pending",
  applications: "pending",
  blocks: "pending",
  leases: "pending",
};

export function useManagerBookingEntries({
  userId,
  propertyIds,
  propertyOptions,
  propertyTick,
  refreshSignal = 0,
}: {
  userId: string | null;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  propertyTick: number;
  refreshSignal?: number;
}) {
  const [airbnbEntries, setAirbnbEntries] = useState<PropertyBookingEntry[]>([]);
  const [occupancyDays, setOccupancyDays] = useState<OccupancyDayLookup>({ overall: {}, houses: {} });
  const [applicationRows, setApplicationRows] = useState<DemoApplicantRow[]>([]);
  const [blocks, setBlocks] = useState<RoomDateBlock[]>([]);
  const [stayMetas, setStayMetas] = useState<StayMeta[]>([]);
  const [sourceStatus, setSourceStatus] = useState<Record<BookingsSourceId, SourceStatus>>(PENDING_SOURCES);
  const [retryTick, setRetryTick] = useState(0);

  const markSource = useCallback((id: BookingsSourceId, status: SourceStatus) => {
    setSourceStatus((current) => (current[id] === status ? current : { ...current, [id]: status }));
  }, []);

  const {
    rows: leaseRows,
    ready: leasesReady,
    failed: leasesFailed,
  } = useLeasePipelineRows(userId, { enabled: Boolean(userId), reloadKey: retryTick });

  useEffect(() => {
    markSource("applications", "pending");
    markSource("blocks", "pending");
  }, [userId, markSource]);

  useEffect(() => {
    if (!leasesReady) markSource("leases", "pending");
    else markSource("leases", leasesFailed ? "failed" : "ok");
  }, [leasesReady, leasesFailed, markSource]);

  // Approved applications hold a room before the lease is signed.
  useEffect(() => {
    if (!userId) {
      setApplicationRows([]);
      markSource("applications", "ok");
      return;
    }
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setApplicationRows(readManagerApplicationRows());
    };
    sync();
    void withTimeout(syncManagerApplicationsFromServerWithStatus({ managerUserId: userId }), PORTAL_READ_TIMEOUT_MS)
      .then((result) => {
        sync();
        // A superseded read (`stale`) says nothing about the server.
        if (!cancelled) markSource("applications", result.ok || result.stale ? "ok" : "failed");
      })
      .catch(() => {
        if (!cancelled) markSource("applications", "failed");
      });
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, sync);
    return () => {
      cancelled = true;
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, sync);
    };
  }, [userId, refreshSignal, retryTick, markSource]);

  // Explicit closed dates, kept on the server so every device sees them.
  useEffect(() => {
    if (!userId) {
      setBlocks([]);
      markSource("blocks", "ok");
      return;
    }
    let cancelled = false;
    const load = () =>
      withTimeout(fetchRoomDateBlocks(), PORTAL_READ_TIMEOUT_MS)
        .then((rows) => {
          if (cancelled) return;
          setBlocks(rows);
          markSource("blocks", "ok");
        })
        .catch(() => {
          if (cancelled) return;
          setBlocks([]);
          markSource("blocks", "failed");
        });
    void load();
    const onChange = () => void load();
    window.addEventListener(ROOM_DATE_BLOCKS_CHANGED, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(ROOM_DATE_BLOCKS_CHANGED, onChange);
    };
  }, [userId, refreshSignal, retryTick, markSource]);

  // Notes and stay details on signed-lease / application stays (C2-BK2). Read
  // failure leaves the stays drawn without them rather than blanking Bookings.
  useEffect(() => {
    if (!userId) {
      setStayMetas([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetchStayMetas()
        .then((rows) => {
          if (!cancelled) setStayMetas(rows);
        })
        .catch(() => {});
    void load();
    const onChange = () => void load();
    window.addEventListener(STAY_META_CHANGED, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(STAY_META_CHANGED, onChange);
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

  // N080: leases whose resident has no surviving Potential/Current/Past
  // application row are orphaned data (a completed delete, or a bug, left
  // them behind) and must not keep drawing a stay on Bookings.
  const directoryEmails = useMemo(() => directoryResidentEmailSet(applicationRows), [applicationRows]);

  // The resident behind a lease, by the same two-way match as `isLeased` below:
  // the Axis id binds exactly; email + property covers a lease whose id was never stamped.
  const applicationForLease = useMemo(() => {
    const byAxisId = new Map<string, ApplicationHoldRow>();
    const byPerson = new Map<string, ApplicationHoldRow>();
    for (const row of applicationRows) {
      const axisId = normalizeApplicationAxisId(row.id);
      if (axisId && !byAxisId.has(axisId)) byAxisId.set(axisId, row);
      const email = row.email?.trim().toLowerCase();
      const propertyId = (row.assignedPropertyId ?? row.propertyId ?? "").trim();
      if (email && !byPerson.has(`${email}|${propertyId}`)) byPerson.set(`${email}|${propertyId}`, row);
    }
    return (lease: { axisId?: string; residentEmail?: string; propertyId?: string }) => {
      const axisId = normalizeApplicationAxisId(lease.axisId ?? "");
      const byId = axisId ? byAxisId.get(axisId) : undefined;
      if (byId) return byId;
      const email = lease.residentEmail?.trim().toLowerCase();
      return email ? byPerson.get(`${email}|${(lease.propertyId ?? "").trim()}`) : undefined;
    };
  }, [applicationRows]);

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
      isResidentLinked: (email) => isLinkedToDirectoryResident(email, directoryEmails),
      applicationForLease,
    });
  }, [userId, leaseRows, propertyOptions, propertyIds, bookingsRoomLabels, directoryEmails, applicationForLease]);

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
      markSource("channel", "ok");
      markSource("occupancy", "ok");
      return;
    }
    // Each fetch settles on its own: one slow or failed source never holds the other back.
    const channel = withTimeout(fetchManagerChannelBookings(ids), PORTAL_READ_TIMEOUT_MS).then(
      (bookings) => {
        setAirbnbEntries(airbnbBookingEntries(bookings));
        markSource("channel", "ok");
      },
      () => {
        setAirbnbEntries([]);
        markSource("channel", "failed");
      },
    );
    const occupancy = withTimeout(
      fetchOccupancySnapshot({ propertyIds: ids, from: occupancyWindow.from, to: occupancyWindow.to }),
      PORTAL_READ_TIMEOUT_MS,
    ).then(
      (snapshot) => {
        const overall: Record<string, OccupancyDayCell> = {};
        const houses: Record<string, OccupancyDayCell> = {};
        for (const day of snapshot.days ?? []) {
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
        markSource("occupancy", "ok");
      },
      () => markSource("occupancy", "failed"),
    );
    await Promise.all([channel, occupancy]);
  }, [propertyIdsKey, occupancyWindow, markSource]);

  useEffect(() => {
    void reloadAirbnb();
  }, [reloadAirbnb, refreshSignal, retryTick]);

  /**
   * The spinner shows only until the FIRST source settles (loaded, failed or
   * timed out); after that the page draws whatever has arrived. Later
   * refreshes keep the stays already on screen.
   */
  const failedSources = useMemo(
    () => BOOKINGS_SOURCE_IDS.filter((id) => sourceStatus[id] === "failed"),
    [sourceStatus],
  );
  const loading = BOOKINGS_SOURCE_IDS.every((id) => sourceStatus[id] === "pending");

  /** Re-run the sources. A failed one stops counting as failed while it retries, so the band clears. */
  const retry = useCallback(() => {
    setSourceStatus((current) => {
      const next = { ...current };
      for (const id of BOOKINGS_SOURCE_IDS) if (next[id] === "failed") next[id] = "pending";
      return next;
    });
    setRetryTick((tick) => tick + 1);
  }, []);

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
      applyStayMeta(
        withoutEchoedHostBlocks(
          [...airbnbEntries, ...importedAirbnbEntries, ...leaseEntries, ...holdEntries, ...blockEntries].filter(
            (entry) => BOOKING_CALENDAR_SOURCES.has(entry.source),
          ),
        ),
        stayMetas,
      ),
    [airbnbEntries, importedAirbnbEntries, leaseEntries, holdEntries, blockEntries, stayMetas],
  );

  return { entries, occupancyDays, loading, failedSources, retry, reloadAirbnb, blocks, residentOptions };
}
