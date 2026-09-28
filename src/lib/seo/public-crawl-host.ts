/**
 * Which Host values may be indexed by search engines for PropLane marketing.
 *
 * Only the canonical production web hosts. Staging (`staging-prop-lane.space`),
 * Vercel previews (`*.vercel.app`), localhost, and every other alias must stay
 * out of Google — robots.txt Disallow + X-Robots-Tag noindex.
 */

export function normalizeCrawlHostname(raw: string): string {
  return raw.split(",")[0]!.trim().split(":")[0]!.toLowerCase();
}

/** Apex + www — www may answer; canonical URLs still point at apex. */
const CANONICAL_PUBLIC_CRAWL_HOSTS = new Set(["proplane.ai", "www.proplane.ai"]);

/**
 * Browser analytics also serves installed native shells still loading an
 * attached legacy production domain. Previews and staging stay excluded.
 */
const PRODUCTION_BROWSER_ANALYTICS_HOSTS = new Set([
  ...CANONICAL_PUBLIC_CRAWL_HOSTS,
  "prop-lane.space",
  "www.prop-lane.space",
  "proplane.space",
  "www.proplane.space",
  "axis-seattle-housing.com",
  "www.axis-seattle-housing.com",
]);

export function isCanonicalPublicCrawlHost(hostname: string): boolean {
  if (!hostname) return false;
  return CANONICAL_PUBLIC_CRAWL_HOSTS.has(normalizeCrawlHostname(hostname));
}

export function isProductionBrowserAnalyticsHost(hostname: string): boolean {
  if (!hostname) return false;
  return PRODUCTION_BROWSER_ANALYTICS_HOSTS.has(normalizeCrawlHostname(hostname));
}

export function requestHostFromHeaders(headers: {
  get(name: string): string | null;
}): string {
  const forwarded = headers.get("x-forwarded-host");
  if (forwarded) return normalizeCrawlHostname(forwarded);
  return normalizeCrawlHostname(headers.get("host") ?? "");
}

export const NOINDEX_ROBOTS_TAG = "noindex, nofollow";
