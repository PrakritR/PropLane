/**
 * Lead source: which listing site a prospect arrived from.
 *
 * The link a manager posts carries `?src=<channelId>`. The public listing page stores it in the
 * first-party cookie `pl_src`; the tour-request and application writes copy it onto the row.
 * Pure on purpose (no `next/headers`) so the client and the tests can use it. The raw value is
 * never trusted: anything that is not exactly an allowlisted channel id is dropped.
 */
export const LEAD_SOURCE_CHANNEL_IDS = [
  "zillow",
  "facebook_marketplace",
  "facebook_groups",
  "craigslist",
  "spareroom",
  "roomies",
  "roomster",
  "zumper_padmapper",
  "apartments_com",
  "redfin_rent",
  "apartment_list",
  "furnished_finder",
  "nextdoor",
  "reddit",
  "facebook_page",
  "instagram",
] as const;

export type LeadSourceChannelId = (typeof LEAD_SOURCE_CHANNEL_IDS)[number];

export const LEAD_SOURCE_COOKIE = "pl_src";
export const LEAD_SOURCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const ALLOWED: ReadonlySet<string> = new Set(LEAD_SOURCE_CHANNEL_IDS);

/** The channel id when `raw` is exactly an allowlisted one, else null. */
export function normalizeLeadSource(raw: unknown): LeadSourceChannelId | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return ALLOWED.has(value) ? (value as LeadSourceChannelId) : null;
}

/** Read `pl_src` out of a raw `Cookie` header (or `document.cookie`). */
export function leadSourceFromCookieHeader(header: string | null | undefined): LeadSourceChannelId | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LEAD_SOURCE_COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return normalizeLeadSource(value);
  }
  return null;
}

/** The `document.cookie` assignment for a valid source, or null when there is nothing to store. */
export function leadSourceCookieAssignment(raw: unknown): string | null {
  const source = normalizeLeadSource(raw);
  if (!source) return null;
  return `${LEAD_SOURCE_COOKIE}=${source}; Max-Age=${LEAD_SOURCE_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
}
