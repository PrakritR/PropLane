"use client";

import { useEffect, useState } from "react";
import { sharedGet } from "@/lib/shared-get-cache";

/** The dispatch route the manager portal already exposes; `sourceType=cleaning` narrows it to turnover cleans. */
export const TURNOVER_CLEANING_RUNS_URL = "/api/portal/vendor-dispatch/runs?sourceType=cleaning";

/** A run that was cancelled, declined, or ran out of vendors is not a cleaning on the calendar. */
const DEAD_RUN_STATUSES = new Set(["canceled", "declined_by_manager", "exhausted"]);

const NONE: ReadonlySet<string> = new Set();

/** The turnover keys (`<stay subjectId>:<checkout date>`) of the live cleaning runs in a dispatch read. */
export function turnoverKeysFromRuns(data: unknown): ReadonlySet<string> {
  const runs = (data as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return NONE;
  const keys = new Set<string>();
  for (const run of runs) {
    const row = run as { sourceType?: unknown; sourceId?: unknown; status?: unknown } | null;
    if (!row || typeof row.sourceId !== "string" || !row.sourceId) continue;
    if (row.sourceType !== undefined && row.sourceType !== "cleaning") continue;
    if (typeof row.status === "string" && DEAD_RUN_STATUSES.has(row.status)) continue;
    keys.add(row.sourceId);
  }
  return keys;
}

/**
 * Which turnovers have a cleaning job, for the calendar's hatched cleaning strip. The read is OPTIONAL: a refusal
 * (no Dispatch access), a failure or a timeout leaves the set empty - the calendar then draws only the red short-gap
 * strip, never a banner and never a failed source. One request per page load through `sharedGet`.
 */
export function useTurnoverCleaningRuns(enabled = true): ReadonlySet<string> {
  const [keys, setKeys] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void sharedGet(TURNOVER_CLEANING_RUNS_URL)
      .then(read => { if (!cancelled && read.ok) setKeys(turnoverKeysFromRuns(read.data)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);
  return enabled ? keys : NONE;
}
