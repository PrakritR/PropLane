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
 * Seeds from the local cache so the calendar can draw stays once the first
 * server sync settles, refreshes on `LEASE_PIPELINE_EVENT`, and leaves cached
 * stays on screen if a later refresh fails. `ready` flips true after the first
 * sync attempt finishes (success or failure) so Bookings can wait for leases
 * alongside channel / applications / blocks instead of painting in waves.
 */
export function useLeasePipelineRows(
  managerUserId: string | null,
  options?: { enabled?: boolean },
): { rows: LeasePipelineRow[]; ready: boolean } {
  const enabled = options?.enabled ?? true;
  const [rows, setRows] = useState<LeasePipelineRow[]>(() =>
    enabled ? readLeasePipeline(managerUserId) : EMPTY_ROWS,
  );
  const [ready, setReady] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setRows(EMPTY_ROWS);
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    const reread = () => setRows(readLeasePipeline(managerUserId));
    reread();
    void syncLeasePipelineFromServer(managerUserId)
      .then((next) => {
        if (!cancelled) setRows(next);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    window.addEventListener(LEASE_PIPELINE_EVENT, reread);
    return () => {
      cancelled = true;
      window.removeEventListener(LEASE_PIPELINE_EVENT, reread);
    };
  }, [enabled, managerUserId]);

  return { rows, ready };
}
