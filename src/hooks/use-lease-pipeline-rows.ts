"use client";

import { useEffect, useState } from "react";
import { PORTAL_READ_TIMEOUT_MS, withTimeout } from "@/lib/auth/fetch-with-timeout";
import {
  LEASE_PIPELINE_EVENT,
  leasePipelineReadSucceeded,
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
 * sync attempt finishes (success, failure or the read timeout) so Bookings
 * never waits on a hung request; `failed` says that attempt did not reach the
 * server, so the cached rows on screen may be stale. `reloadKey` re-runs the
 * sync (Bookings "Retry").
 */
export function useLeasePipelineRows(
  managerUserId: string | null,
  options?: { enabled?: boolean; reloadKey?: number },
): { rows: LeasePipelineRow[]; ready: boolean; failed: boolean } {
  const enabled = options?.enabled ?? true;
  const [rows, setRows] = useState<LeasePipelineRow[]>(() =>
    enabled ? readLeasePipeline(managerUserId) : EMPTY_ROWS,
  );
  const [ready, setReady] = useState(!enabled);
  const [failed, setFailed] = useState(false);
  const reloadKey = options?.reloadKey ?? 0;

  useEffect(() => {
    if (!enabled) {
      setRows(EMPTY_ROWS);
      setFailed(false);
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    setFailed(false);
    const reread = () => setRows(readLeasePipeline(managerUserId));
    reread();
    void withTimeout(syncLeasePipelineFromServer(managerUserId), PORTAL_READ_TIMEOUT_MS)
      .then((next) => {
        if (cancelled) return;
        setRows(next);
        // The store answers a failed GET with its local copy; the read flag is the only tell.
        setFailed(!leasePipelineReadSucceeded(managerUserId));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    window.addEventListener(LEASE_PIPELINE_EVENT, reread);
    return () => {
      cancelled = true;
      window.removeEventListener(LEASE_PIPELINE_EVENT, reread);
    };
  }, [enabled, managerUserId, reloadKey]);

  return { rows, ready, failed };
}
