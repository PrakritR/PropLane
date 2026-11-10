import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";

/** User-facing label for an imported channel event summary. */
export type GuestLabelSource = "airbnb" | "booking_com" | "vrbo" | "ical";

/** The channel's own name: "Airbnb", "Booking.com", "Vrbo", or the site the manager named for an Other calendar. */
export function bookingChannelName(source: GuestLabelSource = "airbnb", channelLabel?: string | null): string {
  return source === "booking_com" ? "Booking.com" : source === "vrbo" ? "Vrbo" : source === "ical" ? channelLabel?.trim() || "Other calendar" : "Airbnb";
}

export function bookingGuestLabel(
  summary: string | null | undefined,
  source: GuestLabelSource = "airbnb",
  channelLabel?: string | null,
): string {
  return channelStayName({ source, summary, channelLabel });
}

/** Short label for a month cell (first name or truncated title). */
export function bookingGuestShortLabel(
  summary: string | null | undefined,
  maxLen = 10,
  source: GuestLabelSource = "airbnb",
  channelLabel?: string | null,
): string {
  const label = bookingGuestLabel(summary, source, channelLabel);
  if (label.length <= maxLen) return label;
  return `${label.slice(0, maxLen - 1)}…`;
}

export function isGuestLabelSource(source: string): source is GuestLabelSource {
  return source === "airbnb" || source === "booking_com" || source === "vrbo" || source === "ical";
}

type GuestLabelEntry = {
  summary: string | null | undefined;
  source: string;
  channelLabel?: string | null;
  guestName?: string | null;
  reservationCode?: string | null;
  residentName?: string | null;
};

/** A feed summary that names nobody: blank, "Reserved", "CLOSED - Not available", a bare channel name, "Booked (…". */
function isGenericChannelSummary(raw: string): boolean {
  if (!raw) return true;
  return (
    /^reserved$/i.test(raw) ||
    /not available/i.test(raw) ||
    /^closed\b/i.test(raw) ||
    /^(airbnb|booking(\.com)?|vrbo)$/i.test(raw) ||
    /^booked \(/i.test(raw)
  );
}

/**
 * The one name for a channel stay: typed name > "Airbnb guest · HM…" > "Closed on <Channel>" for a host
 * block > "<Channel> guest" for a privacy-stripped reservation > the feed's own title.
 * Non-channel sources keep their summary.
 */
export function channelStayName(entry: GuestLabelEntry): string {
  if (!isGuestLabelSource(entry.source)) return entry.summary ?? "";
  const raw = entry.summary?.trim() ?? "";
  const channel = bookingChannelName(entry.source, entry.channelLabel);
  // A host block is no guest: a stray typed name never renames it.
  if (raw && isHostBlockSummary(raw)) return `Closed on ${channel}`;
  const typed = entry.guestName?.trim();
  if (typed) return typed;
  const resident = entry.residentName?.trim();
  if (resident) return resident;
  const code = entry.reservationCode?.trim();
  if (code && entry.source === "airbnb" && isGenericChannelSummary(raw)) {
    return `Airbnb guest · ${code}`;
  }
  if (isGenericChannelSummary(raw)) return `${channel} guest`;
  return raw;
}

/**
 * The identifying label a channel stay earns beyond its feed summary: the name the manager typed,
 * else "Airbnb guest · HMABCDEFGH" when the feed carried a reservation code but only a generic
 * "Reserved". Null when there is nothing better than the existing label (host blocks, other sources).
 */
export function bookingEntryNamedLabel(entry: GuestLabelEntry): string | null {
  if (!isGuestLabelSource(entry.source)) return null;
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
  if (!isGuestLabelSource(entry.source)) {
    return entry.summary ?? "";
  }
  return channelStayName(entry);
}
