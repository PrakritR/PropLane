import { zonedWallTimeMs } from "@/lib/tour-slot-math";

/** Pacific wall-clock parts of an instant. */
export function pacificParts(at: Date): { year: number; month: number; day: number; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hour = Number(read("hour")) % 24;
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    weekday: weekdayNames.indexOf(read("weekday")),
    minutes: hour * 60 + Number(read("minute")),
  };
}

/** Business hours for a dispatch rule: Monday to Friday, 8:00 to 18:00 Pacific. */
export function isBusinessHoursPacific(at: Date): boolean {
  const { weekday, minutes } = pacificParts(at);
  return weekday >= 1 && weekday <= 5 && minutes >= 8 * 60 && minutes < 18 * 60;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** Calendar-day arithmetic that never trips on a DST edge: date parts in, date parts out. */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/**
 * A vendor's "YES 2:30pm", "YES tomorrow 9am", "YES in 2h", "YES fri 3pm" as an
 * instant in Pacific time. Returns null for "now", "asap" or anything it cannot
 * read: the job is then Assigned without a time, never scheduled on a guess.
 * A bare clock time means the next time that clock reads that, today or tomorrow.
 */
export function parseVendorProposedTime(text: string | null | undefined, now: Date): Date | null {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return null;

  const relative = /\bin\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const minutes = relative[2]!.startsWith("h") ? amount * 60 : amount;
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 14 * 1440) return null;
    return new Date(now.getTime() + Math.round(minutes) * 60_000);
  }

  const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d:])/.exec(raw);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]?.[0];
  if (minute > 59 || hour > 24) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else {
    const anchored = Boolean(clock[2]) || /\bat\b/.test(raw) || /(today|tomorrow|tonight)/.test(raw);
    // A bare small number with nothing around it is not obviously a time.
    if (!anchored && hour <= 12) return null;
    // An anchored hour with no am/pm reads as the working afternoon: "YES at 3" is 3 PM, never 3 AM, and a job
    // must not be scheduled in the middle of the night off a missing meridiem.
    if (hour >= 1 && hour <= 7) hour += 12;
  }
  const minutesIntoDay = hour * 60 + minute;

  const today = pacificParts(now);
  let target = { year: today.year, month: today.month, day: today.day };
  let dayOffset: number | null = null;
  if (/\btomorrow\b/.test(raw)) dayOffset = 1;
  else if (/\b(today|tonight)\b/.test(raw)) dayOffset = 0;
  else {
    for (const [name, index] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${name}\\b`).test(raw)) {
        dayOffset = (index - today.weekday + 7) % 7;
        break;
      }
    }
  }
  if (dayOffset != null) target = addDays(today.year, today.month, today.day, dayOffset);
  let ms = zonedWallTimeMs(target.year, target.month, target.day, minutesIntoDay);
  if (dayOffset == null && ms < now.getTime()) {
    const tomorrow = addDays(today.year, today.month, today.day, 1);
    ms = zonedWallTimeMs(tomorrow.year, tomorrow.month, tomorrow.day, minutesIntoDay);
  }
  if (dayOffset === 0 && ms < now.getTime() - 5 * 60_000) return null;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** "2:30pm" / "Fri 2pm" for a Pacific instant, compact for an SMS. */
export function formatPacificShort(at: Date, now: Date = new Date()): string {
  const target = pacificParts(at);
  const today = pacificParts(now);
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(at)
    .replace(/\s/g, "")
    .replace(":00", "")
    .toLowerCase();
  const sameDay = target.year === today.year && target.month === today.month && target.day === today.day;
  if (sameDay) return clock;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(at);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }).format(at);
  const withinWeek = at.getTime() - now.getTime() < 6 * 86_400_000;
  return withinWeek ? `${weekday} ${clock}` : `${date} ${clock}`;
}
