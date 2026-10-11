"use client";

import { useEffect, useMemo, useState } from "react";

import { pacificTodayKey } from "@/lib/room-availability-range";
import { dashboardOccupancyUrl } from "@/lib/dashboard-occupancy";
import { sharedGet } from "@/lib/shared-get-cache";
import type { OccupancySnapshotResponse } from "@/lib/channel-calendar/client";

export type PortfolioOccupancyRead =
  | { status: "loading"; snapshot: OccupancySnapshotResponse | null; today: string }
  | { status: "ok"; snapshot: OccupancySnapshotResponse; today: string }
  | { status: "failed"; snapshot: null; today: string };

/**
 * The occupancy snapshot for a set of houses, through the shared GET cache (one request per URL
 * per page load, whoever else reads it). While a read is in flight the last answer stays; a
 * failed read is `failed`, which the dashboard draws as unknown — never as zero.
 */
export function usePortfolioOccupancy(propertyIds: readonly string[], enabled: boolean): PortfolioOccupancyRead {
  const key = useMemo(() => [...new Set(propertyIds)].filter(Boolean).sort().join(","), [propertyIds]);
  const [today] = useState(() => pacificTodayKey());
  const [read, setRead] = useState<{ key: string; snapshot: OccupancySnapshotResponse | null; failed: boolean }>({
    key: "",
    snapshot: null,
    failed: false,
  });

  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    void sharedGet(dashboardOccupancyUrl(key.split(","), today)).then((result) => {
      if (cancelled) return;
      const snapshot = result.ok && result.data && typeof result.data === "object" ? (result.data as OccupancySnapshotResponse) : null;
      setRead({ key, snapshot, failed: !snapshot });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, today]);

  if (read.failed && read.key === key) return { status: "failed", snapshot: null, today };
  if (read.snapshot && read.key === key) return { status: "ok", snapshot: read.snapshot, today };
  return { status: "loading", snapshot: read.snapshot, today };
}
