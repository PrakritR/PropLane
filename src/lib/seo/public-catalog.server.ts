import "server-only";

import type { MockProperty } from "@/data/types";
import { getPublicListings } from "@/lib/public-listings.server";

/**
 * One public-catalog read per hour, shared by `/sitemap.xml` and every
 * `/rent/listings/<id>` render.
 *
 * `getPublicListings()` is uncached and costs up to 500 rows plus a per-manager send-number and
 * work-email resolution, a profiles read, workspace settings, leasing pipelines and attribution.
 * The sitemap advertises every listing URL to search and AI crawlers, so a crawl would otherwise
 * pay that read once for the sitemap and again for each listing it walks — unbounded Supabase
 * egress on the free plan's budget.
 *
 * The TTL matches the `revalidate = 3600` those surfaces already declare, so nothing here can
 * serve a page staler than the page's own ISR window. A failed read is never cached: the next
 * caller retries, and both callers already render without the catalog when it throws.
 */
const CRAWL_CATALOG_TTL_MS = 3_600_000;

/**
 * How long a caller waits on the read before giving up on it.
 *
 * Nobody may wait on this read forever. `/sitemap.xml` is PRERENDERED, and Next fails the whole
 * build when one route takes more than 60 seconds — so a Supabase read that stalls instead of
 * answering (it normally lands in under three seconds) stops being an incomplete sitemap and
 * becomes a build that cannot ship. Retrying the route does not help either: every attempt joins
 * the same `inFlight` promise, so one stalled read failed all three of Next's attempts.
 *
 * Giving up is not cancelling: the read keeps going and still fills the memo, so the next caller
 * (the ISR revalidation, the next page) gets the catalog without paying a second read. Both
 * callers already render without the catalog when it throws.
 */
export const CRAWL_CATALOG_WAIT_MS = 15_000;

let cached: { expiresAt: number; listings: MockProperty[] } | null = null;
let inFlight: Promise<MockProperty[]> | null = null;

export async function getCrawlPublicListings(): Promise<MockProperty[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.listings;
  if (!inFlight) {
    inFlight = getPublicListings()
      .then((listings) => {
        cached = { expiresAt: Date.now() + CRAWL_CATALOG_TTL_MS, listings };
        return listings;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  const read = inFlight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Public catalog read did not finish in time.")), CRAWL_CATALOG_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tests only: drop the memo so the next read hits the catalog. */
export function resetCrawlPublicListingsCache(): void {
  cached = null;
  inFlight = null;
}
