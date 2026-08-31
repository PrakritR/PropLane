/**
 * Reminder timings, with a direction.
 *
 * A tour is reminded about BEFORE it happens; an application is chased a while
 * AFTER it was submitted. The old model only counted backwards, so "15 minutes
 * after submitted" could not be expressed at all.
 *
 * A timing is stored as `"before:1440"` / `"after:15"` — one string, so it is
 * directly usable as a multi-select value and dedupes without a comparator.
 */

export type TimingDirection = "before" | "after";

export type ReminderTiming = { direction: TimingDirection; minutes: number };

export const MINUTE = 1;
export const HOUR = 60;
export const DAY = 24 * 60;

/** Below five minutes a reminder cannot beat its own dispatch tick. */
export const MIN_TIMING_MINUTES = 5;
/** 30 days. Past this it is a campaign, not a reminder. */
export const MAX_TIMING_MINUTES = 30 * DAY;
/** More than this per subject is a mailing list. */
export const MAX_TIMINGS = 6;

export function clampTimingMinutes(value: number): number {
  if (!Number.isFinite(value)) return MIN_TIMING_MINUTES;
  return Math.max(MIN_TIMING_MINUTES, Math.min(MAX_TIMING_MINUTES, Math.round(value)));
}

/** `"before:1440"`. The stored form and the multi-select value are the same string. */
export function timingKey(timing: ReminderTiming): string {
  return `${timing.direction}:${clampTimingMinutes(timing.minutes)}`;
}

export function parseTimingKey(raw: unknown): ReminderTiming | null {
  if (typeof raw !== "string") return null;
  const [dir, mins] = raw.split(":");
  if (dir !== "before" && dir !== "after") return null;
  // `Number("")` is 0, which is finite — so a blank magnitude would parse and
  // then clamp to the floor, inventing a 5-minute timing nobody asked for.
  // Require actual digits.
  if (!mins || !/^\d+$/.test(mins.trim())) return null;
  const minutes = Number(mins);
  if (!Number.isFinite(minutes)) return null;
  return { direction: dir, minutes: clampTimingMinutes(minutes) };
}

/** "30 minutes", "1 hour", "2 days". */
export function formatMinutes(minutes: number): string {
  const value = clampTimingMinutes(minutes);
  if (value % DAY === 0) {
    const days = value / DAY;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (value % HOUR === 0) {
    const hours = value / HOUR;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${value} ${value === 1 ? "minute" : "minutes"}`;
}

/** "1 day before", "15 minutes after". */
export function formatTiming(timing: ReminderTiming): string {
  return `${formatMinutes(timing.minutes)} ${timing.direction}`;
}

const PRESET_MINUTES = [15 * MINUTE, 30 * MINUTE, 1 * HOUR, 2 * HOUR, 4 * HOUR, 1 * DAY, 2 * DAY, 3 * DAY, 7 * DAY];

/**
 * Options offered for a subject.
 *
 * `before` runs longest-first (a week out, down to fifteen minutes) because
 * that is the order someone plans in; `after` runs shortest-first because
 * chasing starts soon and gets less urgent.
 */
export function timingOptions(directions: readonly TimingDirection[]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  if (directions.includes("before")) {
    for (const minutes of [...PRESET_MINUTES].reverse()) {
      const timing: ReminderTiming = { direction: "before", minutes };
      out.push({ value: timingKey(timing), label: formatTiming(timing) });
    }
  }
  if (directions.includes("after")) {
    for (const minutes of PRESET_MINUTES) {
      const timing: ReminderTiming = { direction: "after", minutes };
      out.push({ value: timingKey(timing), label: formatTiming(timing) });
    }
  }
  return out;
}

/**
 * Clean a stored list: drop unreadable entries, dedupe, and cap.
 *
 * Order is preserved as stored rather than re-sorted — mixing before and after
 * has no single correct ordering, and reordering a manager's own selection
 * makes the control feel like it is fighting them.
 */
export function normalizeTimings(raw: unknown, fallback: readonly string[]): string[] {
  const source = Array.isArray(raw) ? raw : [];
  const parsed = source
    .map((entry) => parseTimingKey(entry))
    .filter((entry): entry is ReminderTiming => entry !== null)
    .map(timingKey);
  const list = parsed.length > 0 ? parsed : [...fallback];
  return [...new Set(list)].slice(0, MAX_TIMINGS);
}

/** "1 day before, 30 minutes before" — a one-line summary for a collapsed control. */
export function summarizeTimings(keys: readonly string[]): string {
  const parts = keys
    .map((key) => parseTimingKey(key))
    .filter((t): t is ReminderTiming => t !== null)
    .map(formatTiming);
  return parts.length > 0 ? parts.join(", ") : "None";
}

/**
 * When a timing fires relative to its anchor.
 *
 * `before` subtracts, `after` adds — the whole reason the direction is stored
 * rather than inferred from the subject.
 */
export function timingSendAt(timing: ReminderTiming, anchor: Date): Date {
  const offsetMs = clampTimingMinutes(timing.minutes) * 60_000;
  return new Date(anchor.getTime() + (timing.direction === "before" ? -offsetMs : offsetMs));
}
