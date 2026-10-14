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
  return inFlight;
}

/** Tests only: drop the memo so the next read hits the catalog. */
export function resetCrawlPublicListingsCache(): void {
  cached = null;
  inFlight = null;
}
