"use client";

import { useEffect, useState } from "react";
import {
  LEASE_PIPELINE_EVENT,
  readLeasePipeline,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

const EMPTY_ROWS: LeasePipelineRow[] = [];

/**
 * PropLane's own stays for any Bookings surface.
 *
 * Seeds from the local cache so the calendar draws stays on the first paint,
 * refreshes from the server, and re-reads on `LEASE_PIPELINE_EVENT` — approving
 * an application, voiding a lease, or completing a signature anywhere else in
 * the session rewrites the store, and the grid must not keep drawing the
 * pre-change occupancy. A failed refresh leaves the cached stays on screen
 * rather than blanking the calendar; the Airbnb half still renders.
 */
export function useLeasePipelineRows(
  managerUserId: string | null,
  options?: { enabled?: boolean },
): LeasePipelineRow[] {
  const enabled = options?.enabled ?? true;
  const [rows, setRows] = useState<LeasePipelineRow[]>(() =>
    enabled ? readLeasePipeline(managerUserId) : EMPTY_ROWS,
  );

  useEffect(() => {
    if (!enabled) {
      setRows(EMPTY_ROWS);
      return;
    }
    let cancelled = false;
    const reread = () => setRows(readLeasePipeline(managerUserId));
    reread();
    void syncLeasePipelineFromServer(managerUserId)
      .then((next) => {
        if (!cancelled) setRows(next);
      })
      .catch(() => {});
    window.addEventListener(LEASE_PIPELINE_EVENT, reread);
    return () => {
      cancelled = true;
      window.removeEventListener(LEASE_PIPELINE_EVENT, reread);
    };
  }, [enabled, managerUserId]);

  return rows;
}
