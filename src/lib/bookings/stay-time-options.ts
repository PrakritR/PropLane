/**
 * Time choices for the Check-in / Check-out dropdowns (listing editor, Add and
 * Edit sheets, imported-stay dialog): every half hour of the day, labelled
 * "3:00 pm". A stored time that is not on the half hour (a legacy 14:15) is
 * kept as its own option so a sheet never silently rewrites it.
 */

import { formatStayTime, normalizeStayTime } from "@/lib/bookings/stay-times";

export type StayTimeOption = { value: string; label: string };

const HALF_HOURS: readonly StayTimeOption[] = Array.from({ length: 48 }, (_, index) => {
  const value = `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}`;
  return { value, label: formatStayTime(value) };
});

export function stayTimeOptions(current?: string | null): StayTimeOption[] {
  const normalized = normalizeStayTime(current);
  if (!normalized || HALF_HOURS.some((option) => option.value === normalized)) return [...HALF_HOURS];
  return [...HALF_HOURS, { value: normalized, label: formatStayTime(normalized) }].sort((a, b) =>
    a.value.localeCompare(b.value),
  );
}

/** Dollars text for a price in cents: 2500 -> "25", 2550 -> "25.50". */
export function centsToDollarsText(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/** Cents for what a manager typed ("$25", "25.5"); null when it is not a number. */
export function dollarsTextToCents(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned || cleaned === ".") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
