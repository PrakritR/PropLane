"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { pacificTodayKey } from "@/lib/room-availability-range";
import { dashboardOccupancyDayKeys, dashboardOccupancyUrl, emptyDashboardOccupancySnapshot } from "@/lib/dashboard-occupancy";
import { sharedGet } from "@/lib/shared-get-cache";
import type { OccupancySnapshotResponse } from "@/lib/channel-calendar/client";
import type { DashboardPeriod } from "@/lib/dashboard-kpis";

/** No answer within this long is "unavailable", never a zero. */
export const PORTFOLIO_OCCUPANCY_TIMEOUT_MS = 12_000;

export type PortfolioOccupancyRead =
  | { status: "loading"; snapshot: OccupancySnapshotResponse | null; today: string; retry: () => void }
  | { status: "ok"; snapshot: OccupancySnapshotResponse; today: string; retry: () => void }
  | { status: "failed"; snapshot: null; today: string; retry: () => void };

/**
 * The occupancy snapshot for a set of houses, through the shared GET cache (one request per URL
 * per page load, whoever else reads it). Only the days the KPI card reads are asked for, so the
 * periods it will draw are part of the request. While a read is in flight the last answer stays;
 * a failed read is `failed`, which the dashboard draws as unknown — never as zero.
 *
 * A manager with no houses yet has nothing to ask about: that is an answered, empty portfolio
 * ("0%") only once the property sync has answered (`propertiesReady`). Before that, "no houses"
 * just means the list has not arrived, so the read stays `loading`. A read with no answer after
 * 12 s is `failed`; `retry` asks again.
 */
export function usePortfolioOccupancy(
  propertyIds: readonly string[],
  enabled: boolean,
  periods: readonly DashboardPeriod[] = [],
  propertiesReady = true,
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

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setRead((prev) => (prev.url === url ? { url: "", snapshot: null, failed: false } : prev));
    setAttempt((n) => n + 1);
  }, [url]);

  useEffect(() => {
    if (!enabled || !url) return;
    let cancelled = false;
    // A read that never answers must not leave the card on a skeleton forever.
    const deadline = setTimeout(() => {
      if (cancelled) return;
      setRead((prev) => (prev.url === url && prev.snapshot ? prev : { url, snapshot: null, failed: true }));
    }, PORTFOLIO_OCCUPANCY_TIMEOUT_MS);
    void sharedGet(url, attempt > 0 ? { force: true } : undefined).then((result) => {
      if (cancelled) return;
      clearTimeout(deadline);
      const snapshot = result.ok && result.data && typeof result.data === "object" ? (result.data as OccupancySnapshotResponse) : null;
      setRead({ url, snapshot, failed: !snapshot });
    });
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
  }, [enabled, url, attempt]);

  // Stable across renders, so a reader can memo on this read without re-running every paint.
  return useMemo(() => {
    if (enabled && !key) {
      return propertiesReady
        ? ({ status: "ok", snapshot: emptyDashboardOccupancySnapshot(emptyDays), today, retry } as const)
        : ({ status: "loading", snapshot: null, today, retry } as const);
    }
    if (read.failed && read.url === url) return { status: "failed", snapshot: null, today, retry } as const;
    if (read.snapshot && read.url === url) return { status: "ok", snapshot: read.snapshot, today, retry } as const;
    return { status: "loading", snapshot: read.snapshot, today, retry } as const;
  }, [emptyDays, enabled, key, propertiesReady, read, retry, today, url]);
}
