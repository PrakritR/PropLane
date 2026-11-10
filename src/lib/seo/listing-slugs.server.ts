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
export async function getListingSlugIndex(): Promise<ListingSlugIndex> {
  try {
    return buildListingSlugIndex(await getCrawlPublicListings());
  } catch {
    return EMPTY_LISTING_SLUG_INDEX;
  }
}

/** The public URL of one listing, readable when it has a slug, the id URL otherwise. Never throws. */
export async function buildReadableListingUrl(origin: string, propertyId: string): Promise<string> {
  const index = await getListingSlugIndex();
  return `${origin.replace(/\/$/, "")}${listingPublicPath(propertyId, index.idToSlug.get(propertyId.trim()))}`;
}
