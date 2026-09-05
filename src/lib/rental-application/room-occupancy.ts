/**
 * Room occupancy capacity — the one decision for "does this room have a free bed?".
 *
 * Client-safe and PURE: no browser storage, no property catalog, no network. The
 * callers in `data.ts` read the rows and hand anonymous placement intervals here,
 * so the same answer can be reached on the server (where the capacity gate must be
 * enforced) and in the browser (where the wizard and catalog render it). Two
 * surfaces disagreeing about whether a room is full is the failure mode this
 * module exists to prevent.
 *
 * Capacity is the MAXIMUM SIMULTANEOUS occupancy of the room, not the number of
 * residents whose stays touch some part of a requested span. Summing every
 * intersecting lease would refuse a second resident in a two-bed room whenever a
 * long search window happened to span two consecutive single stays.
 */

/** A room with no explicit capacity holds one resident, exactly as it always has. */
export const DEFAULT_ROOM_OCCUPANCY_CAPACITY = 1;

/** Matches the wizard's existing 1..20 bedroom-slot ceiling. */
export const MAX_ROOM_OCCUPANCY_CAPACITY = 20;

/** One resident's placement in a room. Dates are local midnight; `end` is INCLUSIVE. */
export type RoomOccupancyPlacement = {
  /** Application id. Used only to dedupe aliases of one row and to exclude the row being edited. */
  id: string;
  start: Date;
  /** Inclusive last day, or null for an open-ended stay that occupies through infinity. */
  end: Date | null;
};

export type RoomOccupancyInterval = {
  start: Date;
  /** Null when the room is full with no known release date. */
  end: Date | null;
};

export type RoomOccupancyEvaluation = {
  /** The normalized capacity actually used, never the raw stored value. */
  capacity: number;
  /** Highest number of residents present on any single day inside the window. */
  peakOccupancy: number;
  /** Free beds at the worst moment in the window. */
  remaining: number;
  hasRoom: boolean;
  /** Day ranges inside the window where the room reaches capacity. */
  fullyBookedIntervals: RoomOccupancyInterval[];
};

export type EvaluateRoomOccupancyParams = {
  capacity: unknown;
  placements: RoomOccupancyPlacement[];
  windowStart: Date;
  /** Null means an open-ended request: evaluate through infinity. */
  windowEnd: Date | null;
  excludeId?: string | null;
};

function isCapacityInRange(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_ROOM_OCCUPANCY_CAPACITY;
}

function parseCapacity(value: unknown): number | null {
  if (typeof value === "number") return isCapacityInRange(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return isCapacityInRange(parsed) ? parsed : null;
  }
  return null;
}

/**
 * How a STORED capacity is read. Anything unreadable falls back to 1 rather than
 * being clamped into range: reading 21 as 20 would invent a capacity the manager
 * never chose, while reading it as 1 can only ever under-sell the room.
 */
export function normalizeRoomOccupancyCapacity(value: unknown): number {
  return parseCapacity(value) ?? DEFAULT_ROOM_OCCUPANCY_CAPACITY;
}

/**
 * Whether an EXPLICIT capacity may be saved. Distinct from reading: a save
 * boundary refuses junk so the manager is told, instead of silently storing a
 * value that later reads back as 1. Absent is valid and means "use the default".
 */
export function isValidRoomOccupancyCapacityInput(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && !value.trim()) return true;
  return parseCapacity(value) !== null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Day number for a local date. Built from the local Y/M/D through Date.UTC so a
 * daylight-saving transition cannot shift a day boundary — `getTime() / MS_PER_DAY`
 * silently does, and these intervals routinely span a DST change.
 */
function dayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY);
}

function dateFromDayIndex(index: number): Date {
  const utc = new Date(index * MS_PER_DAY);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

function normalizeId(id: string | null | undefined): string {
  return String(id ?? "").trim().toLowerCase();
}

type ClippedSpan = { startIdx: number; endIdx: number | null };

function clipPlacements(params: EvaluateRoomOccupancyParams): ClippedSpan[] {
  const windowStartIdx = dayIndex(params.windowStart);
  const windowEndIdx = params.windowEnd ? dayIndex(params.windowEnd) : null;
  const excluded = normalizeId(params.excludeId);
  const seen = new Set<string>();
  const spans: ClippedSpan[] = [];

  for (const placement of params.placements) {
    if (!placement?.start) continue;
    const id = normalizeId(placement.id);
    // An id identifies ONE application. Aliases of it must count once; two
    // different residents with identical dates must both count.
    if (id) {
      if (excluded && id === excluded) continue;
      if (seen.has(id)) continue;
      seen.add(id);
    }

    const startIdx = Math.max(dayIndex(placement.start), windowStartIdx);
    const rawEndIdx = placement.end ? dayIndex(placement.end) : null;

    let endIdx: number | null;
    if (windowEndIdx === null) {
      endIdx = rawEndIdx;
    } else {
      endIdx = rawEndIdx === null ? windowEndIdx : Math.min(rawEndIdx, windowEndIdx);
    }

    if (endIdx !== null && startIdx > endIdx) continue;
    if (windowEndIdx !== null && startIdx > windowEndIdx) continue;
    spans.push({ startIdx, endIdx });
  }

  return spans;
}

export function evaluateRoomOccupancy(params: EvaluateRoomOccupancyParams): RoomOccupancyEvaluation {
  const capacity = normalizeRoomOccupancyCapacity(params.capacity);
  const windowEndIdx = params.windowEnd ? dayIndex(params.windowEnd) : null;
  const spans = clipPlacements(params);

  if (spans.length === 0) {
    return { capacity, peakOccupancy: 0, remaining: capacity, hasRoom: true, fullyBookedIntervals: [] };
  }

  // Sweep the change points. A span [s, e] occupies through the END of day e, so
  // its release event lands on e + 1 — this is what makes a same-day turnover read
  // as an overlap, matching the inclusive rule the product already applies.
  const deltas = new Map<number, number>();
  const bump = (index: number, amount: number) => deltas.set(index, (deltas.get(index) ?? 0) + amount);
  for (const span of spans) {
    bump(span.startIdx, 1);
    if (span.endIdx !== null) bump(span.endIdx + 1, -1);
  }

  const changePoints = [...deltas.keys()].sort((a, b) => a - b);
  const fullyBookedIntervals: RoomOccupancyInterval[] = [];
  let running = 0;
  let peakOccupancy = 0;
  let openFullStart: number | null = null;

  const closeFullRun = (endIdx: number | null) => {
    if (openFullStart === null) return;
    fullyBookedIntervals.push({
      start: dateFromDayIndex(openFullStart),
      end: endIdx === null ? null : dateFromDayIndex(endIdx),
    });
    openFullStart = null;
  };

  for (let i = 0; i < changePoints.length; i += 1) {
    const point = changePoints[i]!;
    running += deltas.get(point) ?? 0;

    // Days outside the requested window never contribute to the answer.
    const insideWindow = windowEndIdx === null || point <= windowEndIdx;
    if (insideWindow) peakOccupancy = Math.max(peakOccupancy, running);

    const isFull = insideWindow && running >= capacity;
    if (isFull && openFullStart === null) {
      openFullStart = point;
    } else if (!isFull && openFullStart !== null) {
      closeFullRun(point - 1);
    }
  }

  // Anything still open after the last change point is an open-ended occupancy:
  // bounded by the window when one was given, otherwise genuinely unbounded.
  if (openFullStart !== null) closeFullRun(windowEndIdx);

  return {
    capacity,
    peakOccupancy,
    remaining: Math.max(0, capacity - peakOccupancy),
    hasRoom: peakOccupancy < capacity,
    fullyBookedIntervals,
  };
}
