/**
 * Lead source: which listing site a prospect arrived from.
 *
 * The link a manager posts carries `?src=<channelId>`. The public listing page stores it in the
 * first-party cookie `pl_src`; the tour-request and application writes copy it onto the row.
 * Pure on purpose (no `next/headers`) so the client and the tests can use it. The raw value is
 * never trusted: anything that is not exactly an allowlisted channel id is dropped.
 */
import { LISTING_CHANNEL_DEFS, type ListingChannelId } from "@/lib/listing-channels/registry";

/**
 * Derived from the registry, never hand-listed: a site added to `LISTING_CHANNEL_DEFS` gets a
 * `?src=<id>` tag the moment it exists, and a second list to keep in step would silently drop that
 * site's leads forever. `registry.ts` is pure and client-safe, so importing it keeps this pure too.
 */
export const LEAD_SOURCE_CHANNEL_IDS: readonly ListingChannelId[] = LISTING_CHANNEL_DEFS.map((def) => def.id);

export type LeadSourceChannelId = ListingChannelId;

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
  // `Secure` on https (the public listing page); omitted on http so localhost still records a tag.
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  return `${LEAD_SOURCE_COOKIE}=${source}; Max-Age=${LEAD_SOURCE_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}
