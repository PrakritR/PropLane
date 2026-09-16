/**
 * The one time-suggestion engine for a manager's non-tour scheduling flows
 * (services, tasks). Availability BOOKS — if the manager painted a future
 * open slot, that is what gets offered. PropLane PICK proposes only when the
 * manager has no future availability at all, choosing a plausible weekday
 * business-hours time so a flow is never blocked on an empty calendar. A pick
 * never overrides anything the manager actually scheduled or painted.
 */
import { resolveNextAvailableSlot, SLOT_STEP_MINUTES } from "@/lib/vendor-availability";
import { tourCalendarDateStr, TOUR_CALENDAR_TIME_ZONE, zonedWallTimeMs } from "@/lib/tour-slot-math";

export type SuggestSource = "availability" | "proplane-pick";
export type ScheduleSuggestion = { iso: string; source: SuggestSource };
export type SuggestBusyWindow = { startIso: string; endIso: string };

/** PropLane pick's business-hours window, in minutes past Pacific midnight. */
export const PROPLANE_PICK_START_MINUTE = 9 * 60;
export const PROPLANE_PICK_END_MINUTE = 17 * 60;
/** How many calendar days out, starting at the next business day, a pick may land on. */
export const PROPLANE_PICK_HORIZON_DAYS = 14;
export const DEFAULT_SUGGEST_DURATION_MINUTES = 60;

/** Shift a `YYYY-MM-DD` Pacific calendar date by whole days (pure calendar math, no zone conversion). */
function shiftPacificDateStr(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 0 (Sun) - 6 (Sat), read off the date's own calendar fields — never an instant conversion. */
function weekdayOf(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

function isWeekend(dateStr: string): boolean {
  const weekday = weekdayOf(dateStr);
  return weekday === 0 || weekday === 6;
}

function pacificMidnightMs(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return zonedWallTimeMs(year!, month!, day!, 0, TOUR_CALENDAR_TIME_ZONE);
}

/** True when any slot key's Pacific date is tomorrow (relative to `now`) or later. */
export function hasFutureAvailability(slotKeys: readonly string[], now: Date = new Date()): boolean {
  const cutoff = shiftPacificDateStr(tourCalendarDateStr(now.getTime(), TOUR_CALENDAR_TIME_ZONE), 1);
  return slotKeys.some((key) => {
    const date = key.split(":")[0];
    return typeof date === "string" && date >= cutoff;
  });
}

function overlapsAnyBusyWindow(busy: readonly SuggestBusyWindow[], startMs: number, durationMinutes: number): boolean {
  const endMs = startMs + durationMinutes * 60_000;
  return busy.some((window) => {
    const busyStart = Date.parse(window.startIso);
    const busyEnd = Date.parse(window.endIso);
    return startMs < busyEnd && endMs > busyStart;
  });
}

/**
 * Chronological ISO starts a PropLane pick may choose from: Pacific weekdays
 * only, every {@link SLOT_STEP_MINUTES} from 9:00, starting at the next
 * business day after `now` and running {@link PROPLANE_PICK_HORIZON_DAYS}
 * calendar days from there, excluding any start that overlaps a busy window.
 */
export function listProplanePickCandidates(input: {
  busy: readonly SuggestBusyWindow[];
  durationMinutes?: number;
  now?: Date;
}): string[] {
  const { busy, durationMinutes = DEFAULT_SUGGEST_DURATION_MINUTES, now = new Date() } = input;

  let startDateStr = shiftPacificDateStr(tourCalendarDateStr(now.getTime(), TOUR_CALENDAR_TIME_ZONE), 1);
  while (isWeekend(startDateStr)) {
    startDateStr = shiftPacificDateStr(startDateStr, 1);
  }

  const candidates: string[] = [];
  for (let offset = 0; offset < PROPLANE_PICK_HORIZON_DAYS; offset += 1) {
    const dateStr = shiftPacificDateStr(startDateStr, offset);
    if (isWeekend(dateStr)) continue;
    const [year, month, day] = dateStr.split("-").map(Number);
    for (
      let minute = PROPLANE_PICK_START_MINUTE;
      minute + durationMinutes <= PROPLANE_PICK_END_MINUTE;
      minute += SLOT_STEP_MINUTES
    ) {
      const startMs = zonedWallTimeMs(year!, month!, day!, minute, TOUR_CALENDAR_TIME_ZONE);
      if (overlapsAnyBusyWindow(busy, startMs, durationMinutes)) continue;
      candidates.push(new Date(startMs).toISOString());
    }
  }
  return candidates;
}

/** FNV-1a, 32-bit, unsigned. Deterministic per seed with no dependency. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Suggest a time for a manager scheduling flow (services/tasks). Availability
 * books: when the manager has painted any future open slot, the suggestion is
 * always the next one that fits and isn't busy — `null` if nothing fits,
 * never a fallback pick, because painted availability is a statement of when
 * the manager IS free. Otherwise a deterministic-per-seed PropLane pick is
 * offered from {@link listProplanePickCandidates}.
 */
export function suggestManagerTime(input: {
  availabilitySlotKeys: readonly string[];
  busy: readonly SuggestBusyWindow[];
  durationMinutes?: number;
  now?: Date;
  seed: string;
  after?: string | null;
}): ScheduleSuggestion | null {
  const {
    availabilitySlotKeys,
    busy,
    durationMinutes = DEFAULT_SUGGEST_DURATION_MINUTES,
    now = new Date(),
    seed,
    after,
  } = input;

  if (hasFutureAvailability(availabilitySlotKeys, now)) {
    const tomorrowStr = shiftPacificDateStr(tourCalendarDateStr(now.getTime(), TOUR_CALENDAR_TIME_ZONE), 1);
    const from = after ? new Date(new Date(after).getTime() + 30 * 60_000) : new Date(pacificMidnightMs(tomorrowStr));
    const iso = resolveNextAvailableSlot({
      rules: [],
      busy: [...busy],
      slotKeys: availabilitySlotKeys,
      durationMinutes,
      from,
      daysToSearch: 60,
    });
    return iso ? { iso, source: "availability" } : null;
  }

  const candidates = listProplanePickCandidates({ busy, durationMinutes, now });
  if (candidates.length === 0) return null;

  if (!after) {
    const index = fnv1a32(seed) % candidates.length;
    return { iso: candidates[index]!, source: "proplane-pick" };
  }

  const next = candidates.find((iso) => iso > after);
  if (next) return { iso: next, source: "proplane-pick" };
  const wrapped = candidates[0]!;
  if (wrapped === after) return null;
  return { iso: wrapped, source: "proplane-pick" };
}
