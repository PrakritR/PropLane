/**
 * Plain-language reason a room cannot be taken for an applicant's dates, plus the nearest dates that work.
 *
 * Pure: the caller hands in the room's fully-booked windows (the SAME windows the listing and the
 * occupancy gate read: `getRoomUnavailabilityWindows`), so the explanation can never disagree with the
 * decision that refused the room. It names dates only: never who or what kind of booking holds them.
 * Window ends are inclusive days; an open end means the room is held indefinitely.
 */
export type RoomConflictWindow = { start: Date | null; end: Date | null };

export type RoomConflictExplanation = {
  /** Windows that overlap the requested dates, in date order (merged where they touch). */
  conflicts: { start: Date | null; end: Date | null }[];
  /** Latest lease end that stops before the first conflict, or null when none fits (it would end before it starts). */
  latestEndBeforeConflict: Date | null;
  /** First start day after the conflict from which the WHOLE requested term is free, or null when none is. */
  nextStartAfterConflict: Date | null;
  message: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function dayNumber(d: Date): number {
  return Math.round(startOfDay(d).getTime() / DAY_MS);
}

const MONTH = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });

/** "Dec 12, 2026" */
export function conflictDayLabel(d: Date): string {
  return `${MONTH(d)} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Dec 12–13, 2026", "Dec 30, 2026 – Jan 2, 2027", "Dec 12, 2026" (one day), "from Dec 12, 2026" (open end). */
export function conflictRangeLabel(start: Date | null, end: Date | null): string {
  if (!start && !end) return "for these dates";
  if (!start) return `through ${conflictDayLabel(end!)}`;
  if (!end) return `from ${conflictDayLabel(start)}`;
  if (dayNumber(start) === dayNumber(end)) return conflictDayLabel(start);
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${MONTH(start)} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
  }
  return `${conflictDayLabel(start)} – ${conflictDayLabel(end)}`;
}

function overlaps(w: RoomConflictWindow, from: Date, to: Date | null): boolean {
  const ws = w.start ? dayNumber(w.start) : -Infinity;
  const we = w.end ? dayNumber(w.end) : Infinity;
  const f = dayNumber(from);
  const t = to ? dayNumber(to) : f;
  return ws <= t && we >= f;
}

export function explainRoomDateConflict(input: {
  roomName: string;
  windows: RoomConflictWindow[];
  leaseStart: Date;
  /** Null for a point-in-time check (start only). */
  leaseEnd: Date | null;
  /** Names of other rooms free for the whole requested term. */
  alternativeRooms?: string[];
}): RoomConflictExplanation | null {
  const sorted = [...input.windows].sort(
    (a, b) => (a.start ? dayNumber(a.start) : -Infinity) - (b.start ? dayNumber(b.start) : -Infinity),
  );
  const hits = sorted.filter((w) => overlaps(w, input.leaseStart, input.leaseEnd));
  if (hits.length === 0) return null;

  // Merge touching/overlapping hits so "Dec 12–13" is one range, not two. An open start is -Infinity: it always
  // touches whatever came before it, so two open-start windows are one conflict, never "booked through X and through Y".
  const conflicts: { start: Date | null; end: Date | null }[] = [];
  for (const w of hits) {
    const last = conflicts[conflicts.length - 1];
    if (last && last.end && (w.start ? dayNumber(w.start) : -Infinity) <= dayNumber(last.end) + 1) {
      if (!w.end) last.end = null;
      else if (dayNumber(w.end) > dayNumber(last.end)) last.end = w.end;
    } else if (last && !last.end) {
      continue;
    } else {
      conflicts.push({ start: w.start, end: w.end });
    }
  }

  const first = conflicts[0]!;
  let latestEndBeforeConflict: Date | null = null;
  if (first.start) {
    const candidate = addDays(first.start, -1);
    // Strictly after the start: a lease that ends the day it begins is not a lease the flow would take.
    if (dayNumber(candidate) > dayNumber(input.leaseStart)) latestEndBeforeConflict = startOfDay(candidate);
  }

  // "A start on <date> or later" is only offered when the applicant's WHOLE term fits from that day: a free day
  // followed by another booking is a term that would be refused again.
  const termDays = input.leaseEnd ? Math.max(0, dayNumber(input.leaseEnd) - dayNumber(input.leaseStart)) : 0;
  let nextStartAfterConflict: Date | null = null;
  if (first.end) {
    let candidate = addDays(first.end, 1);
    for (let guard = 0; guard < 50; guard += 1) {
      const holder = sorted.find((w) => overlaps(w, candidate, termDays > 0 ? addDays(candidate, termDays) : null));
      if (!holder) {
        nextStartAfterConflict = startOfDay(candidate);
        break;
      }
      if (!holder.end) break;
      candidate = addDays(holder.end, 1);
    }
  }

  const where = conflicts.map((c) => conflictRangeLabel(c.start, c.end)).join(" and ");
  const parts = [`${input.roomName} is booked ${where}.`];
  const options: string[] = [];
  if (latestEndBeforeConflict) options.push(`a lease ending ${conflictDayLabel(latestEndBeforeConflict)}`);
  if (nextStartAfterConflict) options.push(`a start on ${conflictDayLabel(nextStartAfterConflict)} or later`);
  if (options.length > 0) parts.push(`Nearest dates that work: ${options.join(", or ")}.`);
  const alts = (input.alternativeRooms ?? []).filter(Boolean);
  if (alts.length > 0) {
    const shown = alts.slice(0, 3).join(", ");
    parts.push(`Free for your whole term: ${shown}${alts.length > 3 ? ", and more" : ""}.`);
  } else if (options.length === 0) {
    parts.push("Choose another room or different dates.");
  }
  return { conflicts, latestEndBeforeConflict, nextStartAfterConflict, message: parts.join(" ") };
}
