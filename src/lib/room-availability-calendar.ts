import { shiftDateKey, spansOverlap } from "@/lib/room-availability-timeline";

export type AvailabilityDayWindow = {
  start?: Date | null;
  end?: Date | null;
};

/** A stored occupied row as date keys — the listing editor's paint/resize unit. */
export type OccupiedDateKeyRange = {
  id: string;
  start: string;
  end: string | null;
};

export type MonthAvailabilityTone = "available" | "unavailable" | "mixed";

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addMonths(base: Date, months: number): Date {
  return new Date(base.getFullYear(), base.getMonth() + months, 1);
}

export function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/** Sunday-start week containing `base`. */
export function startOfWeekSunday(base: Date): Date {
  const d = startOfLocalDay(base);
  return addDays(d, -d.getDay());
}

export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dayIsUnavailable(day: Date, windows: readonly AvailabilityDayWindow[]): boolean {
  const t = startOfLocalDay(day).getTime();
  return windows.some((w) => {
    const start = w.start ? startOfLocalDay(w.start).getTime() : Number.NEGATIVE_INFINITY;
    const end = w.end ? startOfLocalDay(w.end).getTime() : Number.POSITIVE_INFINITY;
    return t >= start && t <= end;
  });
}

export function buildMonthDayCells(monthStart: Date): Array<Date | null> {
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const daysInMonth = monthEnd.getDate();
  const leading = monthStart.getDay();
  const cells: Array<Date | null> = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(new Date(monthStart.getFullYear(), monthStart.getMonth(), d));
  }
  return cells;
}

export function resolveAvailabilityMonthRange(
  windows: readonly AvailabilityDayWindow[],
  options: { horizonMonths?: number; today?: Date } = {},
): { startMonth: Date; monthCount: number } {
  const today = startOfLocalDay(options.today ?? new Date());
  const startMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const horizonMonths = options.horizonMonths ?? 12;
  const defaultEndMonth = addMonths(startMonth, horizonMonths - 1);
  const maxWindowMonth = windows.reduce((latest, w) => {
    const d = w.end ?? w.start;
    if (!d) return latest;
    const m = new Date(d.getFullYear(), d.getMonth(), 1);
    return m.getTime() > latest.getTime() ? m : latest;
  }, startMonth);
  const endMonth =
    maxWindowMonth.getTime() > defaultEndMonth.getTime() ? maxWindowMonth : defaultEndMonth;
  const monthCount =
    (endMonth.getFullYear() - startMonth.getFullYear()) * 12 +
    (endMonth.getMonth() - startMonth.getMonth()) +
    1;
  return { startMonth, monthCount: Math.max(monthCount, 1) };
}

/** Classify a month from today forward: all open days green, all blocked red, otherwise mixed. */
export function monthAvailabilityTone(
  monthStart: Date,
  windows: readonly AvailabilityDayWindow[],
  todayInput?: Date,
): MonthAvailabilityTone {
  const today = startOfLocalDay(todayInput ?? new Date());
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const rangeStart = monthStart.getTime() < today.getTime() ? today : monthStart;
  if (rangeStart.getTime() > monthEnd.getTime()) return "available";

  let hasOpen = false;
  let hasBlocked = false;
  for (let d = rangeStart.getDate(); d <= monthEnd.getDate(); d += 1) {
    const day = new Date(monthStart.getFullYear(), monthStart.getMonth(), d);
    if (dayIsUnavailable(day, windows)) hasBlocked = true;
    else hasOpen = true;
    if (hasOpen && hasBlocked) return "mixed";
  }
  if (hasBlocked) return "unavailable";
  return "available";
}

export function monthToneLabel(tone: MonthAvailabilityTone): string {
  switch (tone) {
    case "available":
      return "Available";
    case "unavailable":
      return "Unavailable";
    case "mixed":
      return "Mixed";
  }
}

/** A YYYY-MM-DD key as a local calendar day; malformed keys read as null. */
export function localDateFromDateKey(dayKey: string | null | undefined): Date | null {
  if (!dayKey) return null;
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function orderedDateKeys(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

const PAINT_WALK_CAP = 400;

/**
 * Walk from `origin` toward `other`, inclusive, and stop before a blocked day.
 * Pointer-down on a blocked day returns null. Occupied (red) days are not blocked —
 * they merge on write. Booked / resident / Airbnb days are blocked.
 */
export function clipPaintRange(
  origin: string,
  other: string,
  isBlocked: (dayKey: string) => boolean,
): { start: string; end: string } | null {
  if (isBlocked(origin)) return null;
  const dir = origin === other ? 0 : origin < other ? 1 : -1;
  let cursor = origin;
  let last = origin;
  let guard = 0;
  while (dir !== 0 && cursor !== other && guard++ < PAINT_WALK_CAP) {
    const next = shiftDateKey(cursor, dir);
    if (isBlocked(next)) break;
    cursor = next;
    last = next;
  }
  const [start, end] = orderedDateKeys(origin, last);
  return { start, end };
}

function rangeTouchesPaint(range: OccupiedDateKeyRange, paintStart: string, paintEnd: string): boolean {
  if (spansOverlap(range, { start: paintStart, end: paintEnd })) return true;
  if (range.end && shiftDateKey(range.end, 1) === paintStart) return true;
  if (shiftDateKey(paintEnd, 1) === range.start) return true;
  return false;
}

/**
 * Insert a painted Occupied span, merging any overlapping or adjacent manual rows
 * into one. `newId` is used only when nothing exists to merge into.
 */
export function mergePaintedOccupiedRanges(
  ranges: readonly OccupiedDateKeyRange[],
  paintStart: string,
  paintEnd: string,
  newId: string,
): OccupiedDateKeyRange[] {
  const touching = ranges.filter((r) => rangeTouchesPaint(r, paintStart, paintEnd));
  const rest = ranges.filter((r) => !touching.includes(r));
  if (touching.length === 0) {
    return [...rest, { id: newId, start: paintStart, end: paintEnd }];
  }
  const start = [paintStart, ...touching.map((r) => r.start)].reduce((a, b) => (a < b ? a : b));
  const end = [paintEnd, ...touching.map((r) => r.end)].some((e) => e === null)
    ? null
    : [paintEnd, ...touching.map((r) => r.end as string)].reduce((a, b) => (a > b ? a : b));
  return [...rest, { id: touching[0]!.id, start, end }];
}

function rangeContainsBooked(
  start: string,
  end: string | null,
  isBooked: (dayKey: string) => boolean,
): boolean {
  if (end === null) {
    return isBooked(start);
  }
  let cursor = start;
  let guard = 0;
  while (guard++ < PAINT_WALK_CAP) {
    if (isBooked(cursor)) return true;
    if (cursor === end) return false;
    cursor = shiftDateKey(cursor, 1);
    if (cursor > end) return false;
  }
  return false;
}

/**
 * Move one edge of a manual occupied span. Refuses inverted ranges and any
 * proposed span that would cover a booked day. Merges if the result touches
 * another manual row.
 */
export function resizeOccupiedDateRange(
  ranges: readonly OccupiedDateKeyRange[],
  id: string,
  edge: "start" | "end",
  toDay: string,
  isBooked: (dayKey: string) => boolean,
): OccupiedDateKeyRange[] | null {
  const current = ranges.find((r) => r.id === id);
  if (!current) return null;
  const start = edge === "start" ? toDay : current.start;
  const end = edge === "end" ? toDay : current.end;
  if (end !== null && end < start) return null;
  if (end === null) {
    if (edge === "start" && toDay < current.start && rangeContainsBooked(toDay, shiftDateKey(current.start, -1), isBooked)) {
      return null;
    }
  } else if (rangeContainsBooked(start, end, isBooked)) {
    return null;
  }
  const next = ranges.map((r) => (r.id === id ? { ...r, start, end } : r));
  const resized = next.find((r) => r.id === id)!;
  if (resized.end === null) return next;
  return mergePaintedOccupiedRanges(
    next.filter((r) => r.id !== id),
    resized.start,
    resized.end,
    resized.id,
  );
}
