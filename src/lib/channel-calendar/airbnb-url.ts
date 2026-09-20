import {
  CHANNEL_CALENDAR_PROVIDERS,
  type ChannelCalendarProvider,
} from "@/lib/channel-calendar/types";

const AIRBNB_ICAL_HOSTS = new Set(["www.airbnb.com", "airbnb.com", "www.airbnb.ca", "airbnb.ca"]);
const BOOKING_ICAL_HOSTS = new Set(["ical.booking.com", "admin.booking.com"]);

/** Channel calendar export URLs only — rejects arbitrary fetch targets. */
/**
 * A bad import URL is the manager mistyping a field, not a server fault. Routes
 * map this to a 400 with the message shown inline next to the input; a plain
 * `Error` used to fall into the generic catch and answer 500, which the modal
 * rendered as nothing at all.
 */
export class ChannelCalendarInputError extends Error {
  readonly field: "importUrl";
  constructor(message: string) {
    super(message);
    this.name = "ChannelCalendarInputError";
    this.field = "importUrl";
  }
}

export function isChannelCalendarInputError(e: unknown): e is ChannelCalendarInputError {
  return e instanceof Error && e.name === "ChannelCalendarInputError";
}

export function isChannelCalendarProvider(value: unknown): value is ChannelCalendarProvider {
  return CHANNEL_CALENDAR_PROVIDERS.includes(value as ChannelCalendarProvider);
}

export function parseChannelCalendarProvider(raw: unknown): ChannelCalendarProvider | null {
  const value = String(raw ?? "").trim();
  return isChannelCalendarProvider(value) ? value : null;
}

export function channelCalendarProviderLabel(provider: ChannelCalendarProvider): string {
  return provider === "booking_com" ? "Booking.com" : "Airbnb";
}

function parseHttpsUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function isValidAirbnbImportUrl(raw: string): boolean {
  const url = parseHttpsUrl(raw);
  if (!url) return false;
  if (!AIRBNB_ICAL_HOSTS.has(url.hostname.toLowerCase())) return false;
  return url.pathname.toLowerCase().includes("/calendar/ical/");
}

export function isValidBookingComImportUrl(raw: string): boolean {
  const url = parseHttpsUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (!BOOKING_ICAL_HOSTS.has(host)) return false;
  const path = url.pathname.toLowerCase();
  if (host === "ical.booking.com") return path.includes("/export") || path.includes("/ical");
  return path.includes("/ical");
}

export function isValidChannelImportUrl(provider: ChannelCalendarProvider, raw: string): boolean {
  return provider === "booking_com" ? isValidBookingComImportUrl(raw) : isValidAirbnbImportUrl(raw);
}

export function channelImportUrlErrorMessage(provider: ChannelCalendarProvider): string {
  if (provider === "booking_com") {
    return "That is not a Booking.com calendar link. In Booking.com go to Rates & Availability → Sync calendars → Skip to export, and paste the https://ical.booking.com/v1/export?t=… URL.";
  }
  return "That is not an Airbnb calendar link. In Airbnb go to Calendar → Availability → Connect calendars → Export calendar, and paste the https://www.airbnb.com/calendar/ical/… URL.";
}

export function normalizeAirbnbImportUrl(raw: string): string {
  return raw.trim();
}

export function normalizeChannelImportUrl(raw: string): string {
  return raw.trim();
}
