import { isPrivateOrInternalHostname } from "@/lib/channel-calendar/ical-host";
import {
  CHANNEL_CALENDAR_PROVIDERS,
  type ChannelCalendarProvider,
} from "@/lib/channel-calendar/types";

const AIRBNB_ICAL_HOSTS = new Set(["www.airbnb.com", "airbnb.com", "www.airbnb.ca", "airbnb.ca"]);
const BOOKING_ICAL_HOSTS = new Set(["ical.booking.com", "admin.booking.com"]);
const VRBO_ICAL_HOSTS = new Set(["vrbo.com", "www.vrbo.com", "homeaway.com", "www.homeaway.com"]);
/** Vrbo's export is /icalendar/<token>.ics, optionally followed by a query such as ?nonTentative. */
const VRBO_ICAL_PATH = /^\/icalendar\/[A-Za-z0-9_-]+\.ics$/i;

/** Channel calendar export URLs only — rejects arbitrary fetch targets. */
/**
 * A bad import URL is the manager mistyping a field, not a server fault. Routes
 * map this to a 400 with the message shown inline next to the input; a plain
 * `Error` used to fall into the generic catch and answer 500, which the modal
 * rendered as nothing at all.
 */
export class ChannelCalendarInputError extends Error {
  readonly field: "importUrl" | "label";
  constructor(message: string, field: "importUrl" | "label" = "importUrl") {
    super(message);
    this.name = "ChannelCalendarInputError";
    this.field = field;
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

/** The server's own cap on checking one Other calendar link before it is saved. */
export const ICAL_VALIDATE_TIMEOUT_MS = 6_000;

/** The longest site name an "Other calendar" link may carry. */
export const ICAL_LABEL_MAX_LENGTH = 40;

/** "Houfy", trimmed and collapsed; "" when nothing usable. */
export function normalizeIcalLabel(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, ICAL_LABEL_MAX_LENGTH);
}

/** Two site names are the same link when they match ignoring case. */
export function icalLabelKey(raw: unknown): string {
  return normalizeIcalLabel(raw).toLowerCase();
}

/**
 * The name shown for a channel. An "Other calendar" link is the site the manager typed
 * (`label`); every other provider is a fixed name and ignores the label.
 */
export function channelCalendarProviderLabel(provider: ChannelCalendarProvider, label?: string | null): string {
  if (provider === "ical") return normalizeIcalLabel(label) || "Other calendar";
  if (provider === "booking_com") return "Booking.com";
  if (provider === "vrbo") return "Vrbo";
  return "Airbnb";
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

export function isValidVrboImportUrl(raw: string): boolean {
  const url = parseHttpsUrl(raw);
  if (!url) return false;
  if (!VRBO_ICAL_HOSTS.has(url.hostname.toLowerCase())) return false;
  return VRBO_ICAL_PATH.test(url.pathname);
}

/**
 * "Other calendar": any https URL whose path ends in .ics or contains /ical/ or /calendar/. No host
 * allowlist - the site is whatever the manager names - but never a loopback, private or internal host
 * (DNS is re-checked when the feed is fetched).
 */
export function isValidIcalImportUrl(raw: string): boolean {
  const url = parseHttpsUrl(raw);
  if (!url) return false;
  if (url.username || url.password) return false;
  if (isPrivateOrInternalHostname(url.hostname)) return false;
  const path = url.pathname.toLowerCase();
  return path.endsWith(".ics") || path.includes("/ical/") || path.includes("/calendar/");
}

export function isValidChannelImportUrl(provider: ChannelCalendarProvider, raw: string): boolean {
  if (provider === "ical") return isValidIcalImportUrl(raw);
  if (provider === "booking_com") return isValidBookingComImportUrl(raw);
  if (provider === "vrbo") return isValidVrboImportUrl(raw);
  return isValidAirbnbImportUrl(raw);
}

export function channelImportUrlErrorMessage(provider: ChannelCalendarProvider): string {
  if (provider === "ical") {
    return "That is not a calendar link. Paste the site's https calendar (iCal) export link - it ends in .ics or contains /ical/ or /calendar/ - and make sure it is not a link to a private or local address.";
  }
  if (provider === "booking_com") {
    return "That is not a Booking.com calendar link. In Booking.com go to Rates & Availability → Sync calendars → Skip to export, and paste the https://ical.booking.com/v1/export?t=… URL.";
  }
  if (provider === "vrbo") {
    return "That is not a Vrbo calendar link. In Vrbo go to Calendar → Import & export → Export calendar, and paste the https://www.vrbo.com/icalendar/….ics URL.";
  }
  return "That is not an Airbnb calendar link. In Airbnb go to Calendar → Availability → Connect calendars → Export calendar, and paste the https://www.airbnb.com/calendar/ical/… URL.";
}

export function normalizeAirbnbImportUrl(raw: string): string {
  return raw.trim();
}

export function normalizeChannelImportUrl(raw: string): string {
  return raw.trim();
}
