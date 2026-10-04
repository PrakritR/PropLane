import { zonedWallTimeMs } from "@/lib/tour-slot-math";

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

/** Parse a date-only string that may be YYYY-MM-DD or M/D/YYYY without mangling it. */
function parseDateOnlyString(raw: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00`);
  }
  return new Date(raw);
}

export function formatPacificDate(date: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string {
  try {
    const d = typeof date === "string" && !/[T Z]/.test(date) ? parseDateOnlyString(date) : new Date(date);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: PACIFIC_TIME_ZONE,
      ...options,
    }).format(d);
  } catch {
    return "—";
  }
}

export function formatPacificDateTime(date: Date | string | number): string {
  return formatPacificDate(date, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function safeFormatDateTime(value: string | undefined | null, fallback = "—"): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return formatPacificDateTime(d);
}

/** Today's calendar date in Pacific time as YYYY-MM-DD. */
export function pacificCalendarDateYmd(now: Date | number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

/**
 * The instant a Pacific calendar day (`YYYY-MM-DD`) begins, or null when the date is unusable.
 *
 * A bare wall date has no instant of its own, and resolving one with `new Date(y, m - 1, d)`
 * reads the RUNTIME's zone — Pacific on a manager's laptop, UTC in a Vercel Node function. The
 * same stored date then meant two different deadlines on two surfaces, so every day boundary
 * the product reasons about is anchored here instead.
 */
export function pacificStartOfDayMs(ymd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) return null;
  return zonedWallTimeMs(Number(match[1]), Number(match[2]), Number(match[3]), 0, PACIFIC_TIME_ZONE);
}

/**
 * The instant a Pacific calendar day ENDS — the start of the following Pacific day, so the
 * 23- and 25-hour days either side of a DST change land exactly rather than a flat 24 hours on.
 */
export function pacificEndOfDayMs(ymd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) return null;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return zonedWallTimeMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, PACIFIC_TIME_ZONE);
}

/** The instant the Pacific calendar day containing `now` began. */
export function pacificStartOfTodayMs(now: Date | number = Date.now()): number {
  const ymd = pacificCalendarDateYmd(now);
  return pacificStartOfDayMs(ymd) ?? Date.parse(`${ymd}T00:00:00Z`);
}
