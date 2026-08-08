/** User-facing label for an Airbnb imported event summary. */
export function bookingGuestLabel(summary: string | null | undefined): string {
  const raw = summary?.trim() ?? "";
  if (!raw) return "Booked (Airbnb)";
  const lower = raw.toLowerCase();
  if (lower === "reserved" || lower === "not available" || lower === "blocked") {
    return "Booked (Airbnb)";
  }
  return raw;
}

/** Short label for a month cell (first name or truncated title). */
export function bookingGuestShortLabel(summary: string | null | undefined, maxLen = 10): string {
  const label = bookingGuestLabel(summary);
  if (label.length <= maxLen) return label;
  return `${label.slice(0, maxLen - 1)}…`;
}
