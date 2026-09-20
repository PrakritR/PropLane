/** User-facing label for an imported channel event summary. */
export function bookingGuestLabel(
  summary: string | null | undefined,
  source: "airbnb" | "booking_com" = "airbnb",
): string {
  const raw = summary?.trim() ?? "";
  const channel = source === "booking_com" ? "Booking.com" : "Airbnb";
  const fallback = `Booked (${channel})`;
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === "reserved" || lower === "not available" || lower === "blocked") {
    return fallback;
  }
  return raw;
}

/** Short label for a month cell (first name or truncated title). */
export function bookingGuestShortLabel(
  summary: string | null | undefined,
  maxLen = 10,
  source: "airbnb" | "booking_com" = "airbnb",
): string {
  const label = bookingGuestLabel(summary, source);
  if (label.length <= maxLen) return label;
  return `${label.slice(0, maxLen - 1)}…`;
}
