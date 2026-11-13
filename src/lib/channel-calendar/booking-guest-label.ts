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

/**
 * A feed summary that names nobody: blank, "Reserved", the privacy-stripped "CLOSED - Not available"
 * Booking.com and Vrbo write, a bare channel name, "Booked (…".
 *
 * Matched on the WHOLE title, never a prefix: an Other calendar's real event ("Closed for renovation",
 * "Owner stay - not available") keeps its own words rather than being announced as a guest.
 */
function isGenericChannelSummary(raw: string): boolean {
  if (!raw) return true;
  return (
    /^reserved$/i.test(raw) ||
    /^not available$/i.test(raw) ||
    /^closed(?:\s*[-–—:]\s*not available)?$/i.test(raw) ||
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
 * What a booking is called wherever a guest label is drawn (list row, record title, day card,
 * conflict line). One rule, {@link channelStayName}; every non-channel source keeps its own label.
 */
export function bookingEntryGuestLabel(entry: GuestLabelEntry): string {
  return channelStayName(entry);
}
