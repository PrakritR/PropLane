import "server-only";

import { buildListingSlugIndex, EMPTY_LISTING_SLUG_INDEX, type ListingSlugIndex } from "@/lib/listing-slug";
import { listingPublicPath } from "@/lib/listing-public-path";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";

/**
 * The slug index of the published public catalog: the SAME hourly read `/sitemap.xml` and `/rent/listings/*` already share
 * (`getCrawlPublicListings`, `publicListingProjection` rows only), so a slug exists exactly for a listing the public site
 * lists and costs no extra Supabase read. A failed or slow read gives the empty index: every URL falls back to the id
 * form, which still resolves, and nothing is cached.
 */
/**
 * Built once per catalog read, not once per call: the index is memoized on the identity of the cached catalog array,
 * so it is rebuilt only when `getCrawlPublicListings` hands back a new one (its own hourly TTL). An SMS reply that
 * links several homes derives the slugs over the whole catalog once instead of once per home.
 */
let memo: { listings: Awaited<ReturnType<typeof getCrawlPublicListings>>; index: ListingSlugIndex } | null = null;

export async function getListingSlugIndex(): Promise<ListingSlugIndex> {
  try {
    const listings = await getCrawlPublicListings();
    if (memo && memo.listings === listings) return memo.index;
    const index = buildListingSlugIndex(listings);
    memo = { listings, index };
    return index;
  } catch {
    return EMPTY_LISTING_SLUG_INDEX;
  }
}

/** The public URL of one listing, readable when it has a slug, the id URL otherwise. Never throws. */
export async function buildReadableListingUrl(origin: string, propertyId: string): Promise<string> {
  const index = await getListingSlugIndex();
  return `${origin.replace(/\/$/, "")}${listingPublicPath(propertyId, index.idToSlug.get(propertyId.trim()))}`;
}
