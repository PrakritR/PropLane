import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";

/** User-facing label for an imported channel event summary. */
export function bookingGuestLabel(
  summary: string | null | undefined,
  source: "airbnb" | "booking_com" | "vrbo" = "airbnb",
): string {
  const raw = summary?.trim() ?? "";
  const channel = source === "booking_com" ? "Booking.com" : source === "vrbo" ? "Vrbo" : "Airbnb";
  const fallback = `Booked (${channel})`;
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (isHostBlockSummary(raw)) return `${channel} block`;
  if (lower === "reserved") return fallback;
  return raw;
}

/** Short label for a month cell (first name or truncated title). */
export function bookingGuestShortLabel(
  summary: string | null | undefined,
  maxLen = 10,
  source: "airbnb" | "booking_com" | "vrbo" = "airbnb",
): string {
  const label = bookingGuestLabel(summary, source);
  if (label.length <= maxLen) return label;
  return `${label.slice(0, maxLen - 1)}…`;
}

type GuestLabelEntry = {
  summary: string | null | undefined;
  source: string;
  guestName?: string | null;
  reservationCode?: string | null;
};

/**
 * The identifying label a channel stay earns beyond its feed summary: the name the manager typed,
 * else "Airbnb guest · HMABCDEFGH" when the feed carried a reservation code but only a generic
 * "Reserved". Null when there is nothing better than the existing label (host blocks, other sources).
 */
export function bookingEntryNamedLabel(entry: GuestLabelEntry): string | null {
  if (entry.source !== "airbnb" && entry.source !== "booking_com" && entry.source !== "vrbo") return null;
  const raw = entry.summary?.trim() ?? "";
  if (raw && isHostBlockSummary(raw)) return null;
  const typed = entry.guestName?.trim();
  if (typed) return typed;
  const code = entry.reservationCode?.trim();
  if (code && entry.source === "airbnb" && (!raw || raw.toLowerCase() === "reserved")) return `Airbnb guest · ${code}`;
  return null;
}

/**
 * What a booking is called wherever a guest label is drawn (list row, record title, day card).
 * Channel stay precedence: manager-typed name > "Airbnb guest · code" > the existing label.
 * Host blocks and every non-channel source keep their own label.
 */
export function bookingEntryGuestLabel(entry: GuestLabelEntry): string {
  if (entry.source !== "airbnb" && entry.source !== "booking_com" && entry.source !== "vrbo") {
    return entry.summary ?? "";
  }
  return bookingEntryNamedLabel(entry) ?? bookingGuestLabel(entry.summary, entry.source);
}
