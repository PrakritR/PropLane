const AIRBNB_ICAL_HOSTS = new Set(["www.airbnb.com", "airbnb.com", "www.airbnb.ca", "airbnb.ca"]);

/** Airbnb calendar export URLs only — rejects arbitrary fetch targets. */
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

export function isValidAirbnbImportUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!AIRBNB_ICAL_HOSTS.has(url.hostname.toLowerCase())) return false;
  const path = url.pathname.toLowerCase();
  return path.includes("/calendar/ical/");
}

export function normalizeAirbnbImportUrl(raw: string): string {
  return raw.trim();
}
