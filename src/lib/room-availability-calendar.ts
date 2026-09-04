export type AvailabilityDayWindow = {
  start?: Date | null;
  end?: Date | null;
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

export function dayIsUnavailable(day: Date, windows: AvailabilityDayWindow[]): boolean {
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
  windows: AvailabilityDayWindow[],
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
  windows: AvailabilityDayWindow[],
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
      return "Open";
    case "unavailable":
      return "Unavailable";
    case "mixed":
      return "Mixed";
  }
}
