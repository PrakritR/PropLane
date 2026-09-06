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
