"use client";

import { useEffect, useMemo, useState } from "react";

import { pacificTodayKey } from "@/lib/room-availability-range";
import { dashboardOccupancyDayKeys, dashboardOccupancyUrl, emptyDashboardOccupancySnapshot } from "@/lib/dashboard-occupancy";
import { sharedGet } from "@/lib/shared-get-cache";
import type { OccupancySnapshotResponse } from "@/lib/channel-calendar/client";
import type { DashboardPeriod } from "@/lib/dashboard-kpis";

export type PortfolioOccupancyRead =
  | { status: "loading"; snapshot: OccupancySnapshotResponse | null; today: string }
  | { status: "ok"; snapshot: OccupancySnapshotResponse; today: string }
  | { status: "failed"; snapshot: null; today: string };

/**
 * The occupancy snapshot for a set of houses, through the shared GET cache (one request per URL
 * per page load, whoever else reads it). Only the days the KPI card reads are asked for, so the
 * periods it will draw are part of the request. While a read is in flight the last answer stays;
 * a failed read is `failed`, which the dashboard draws as unknown — never as zero.
 *
 * A manager with no houses yet has nothing to ask about: that is an answered, empty portfolio
 * ("0%"), not a read that never comes back.
 */
export function usePortfolioOccupancy(
  propertyIds: readonly string[],
  enabled: boolean,
  periods: readonly DashboardPeriod[] = [],
): PortfolioOccupancyRead {
  const key = useMemo(() => [...new Set(propertyIds)].filter(Boolean).sort().join(","), [propertyIds]);
  const [today] = useState(() => pacificTodayKey());
  const url = useMemo(() => (key ? dashboardOccupancyUrl(key.split(","), today, periods) : ""), [key, today, periods]);
  const emptyDays = useMemo(() => dashboardOccupancyDayKeys(today, periods), [today, periods]);
  const [read, setRead] = useState<{ url: string; snapshot: OccupancySnapshotResponse | null; failed: boolean }>({
    url: "",
    snapshot: null,
    failed: false,
  });

  useEffect(() => {
    if (!enabled || !url) return;
    let cancelled = false;
    void sharedGet(url).then((result) => {
      if (cancelled) return;
      const snapshot = result.ok && result.data && typeof result.data === "object" ? (result.data as OccupancySnapshotResponse) : null;
      setRead({ url, snapshot, failed: !snapshot });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, url]);

  // Stable across renders, so a reader can memo on this read without re-running every paint.
  return useMemo(() => {
    if (enabled && !key) return { status: "ok", snapshot: emptyDashboardOccupancySnapshot(emptyDays), today } as const;
    if (read.failed && read.url === url) return { status: "failed", snapshot: null, today } as const;
    if (read.snapshot && read.url === url) return { status: "ok", snapshot: read.snapshot, today } as const;
    return { status: "loading", snapshot: read.snapshot, today } as const;
  }, [emptyDays, enabled, key, read, today, url]);
}
