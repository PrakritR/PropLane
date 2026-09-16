import { createHash } from "node:crypto";

import { formatPacificDate } from "@/lib/pacific-time";
import {
  mergeTourAvailabilitySlotsIntoWindows,
  partitionTourAvailabilityStoredKeys,
  payloadSlots,
  type TourAvailabilityWindow,
} from "@/lib/tour-slot-math";

export type AvailabilityChange = {
  /** Deterministic on WHAT changed (the opened/closed windows), never on when the save ran. */
  changeKey: string;
  /** Team-thread copy, in the voice `emitAvailabilityChangedEvent` expects ("<name> <summary>."). */
  summary: string;
  opened: TourAvailabilityWindow[];
  closed: TourAvailabilityWindow[];
};

function windowLabel(window: TourAvailabilityWindow): string {
  const day = formatPacificDate(window.start, { weekday: "short", month: "short", day: "numeric" });
  const from = formatPacificDate(window.start, { hour: "numeric", minute: "2-digit" });
  const to = formatPacificDate(window.end, { hour: "numeric", minute: "2-digit" });
  return `${day} ${from}–${to}`;
}

function describe(verb: string, windows: TourAvailabilityWindow[]): string {
  if (windows.length === 1) return `${verb} ${windowLabel(windows[0]!)}`;
  return `${verb} ${windows.length} tour windows`;
}

/**
 * What one availability save changed, for the team notice. Compares the
 * published (bookable) slot sets before and after the write and merges each
 * side of the diff into windows; `null` when nothing bookable changed (a
 * no-op save, a past-only edit, an exclusion marker on a day that was
 * already closed).
 */
export function summarizeAvailabilityChange(
  previousRowData: unknown,
  nextRowData: unknown,
  now: number = Date.now(),
): AvailabilityChange | null {
  const before = new Set(partitionTourAvailabilityStoredKeys(payloadSlots(previousRowData)).publishedSlots);
  const after = new Set(partitionTourAvailabilityStoredKeys(payloadSlots(nextRowData)).publishedSlots);
  const opened = mergeTourAvailabilitySlotsIntoWindows([...after].filter((key) => !before.has(key)), now);
  const closed = mergeTourAvailabilitySlotsIntoWindows([...before].filter((key) => !after.has(key)), now);
  if (opened.length === 0 && closed.length === 0) return null;

  const parts: string[] = [];
  if (opened.length > 0) parts.push(describe("opened", opened));
  if (closed.length > 0) parts.push(describe("closed", closed));
  const digest = createHash("sha1")
    .update(JSON.stringify({ opened, closed }))
    .digest("hex")
    .slice(0, 16);
  return { changeKey: digest, summary: parts.join(" and "), opened, closed };
}
