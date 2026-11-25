import "server-only";

import { cache } from "react";

import type { MockProperty } from "@/data/types";
import {
  buildListingSlugIndex,
  EMPTY_LISTING_SLUG_INDEX,
  isMintedListingIdToken,
  listingCanonicalSlug,
  listingTokenOfParam,
  resolveListingParam,
  type ListingParamResolution,
  type ListingSlugIndex,
} from "@/lib/listing-slug";
import { listingPublicPath } from "@/lib/listing-public-path";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

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

/**
 * The stored listing behind one minted id token. A trailing match on the id can use no index, so this is a scan of
 * the property table: the one caller fires it only while the catalog read that normally answers is down.
 */
async function liveListingForIdToken(token: string): Promise<{ id: string; slug: string } | null> {
  try {
    const { data, error } = await createSupabaseServiceRoleClient()
      .from("manager_property_records")
      .select("id, property_data")
      .eq("status", "live")
      .is("test_workspace_id", null)
      // `listingIdToken` lower-cases the id it took the token from, so the match has to.
      .ilike("id", `%-${token}`)
      .limit(2);
    // Two ids ending in one token name neither listing, exactly as `buildListingSlugIndex` drops a shared token.
    if (error || !data || data.length !== 1) return null;
    const row = data[0] as { id?: unknown; property_data?: unknown };
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) return null;
    const stored =
      row.property_data && typeof row.property_data === "object" && !Array.isArray(row.property_data)
        ? (row.property_data as MockProperty)
        : null;
    return { id, slug: listingCanonicalSlug({ ...(stored ?? {}), id, address: stored?.address ?? "" }) };
  } catch {
    return null;
  }
}

/**
 * The listing a `/rent/listings/<param>` segment names. Cached per request, so `generateMetadata` and the page body
 * resolve the param once between them.
 *
 * The hourly catalog index answers it for nothing, and an unknown param against a readable index is simply not
 * found. But a slug URL is DURABLE — texted, syndicated, shared, indexed — so when that read FAILED and there is no
 * index at all, the param's own id token is resolved by a single bounded read of the live public records instead.
 * That read is a table scan, so it stays inside the outage: a token no single live listing owns leaves the param
 * alone, which is the id form that resolved before slugs existed.
 */
export const resolvePublicListingParam = cache(async (param: string): Promise<ListingParamResolution> => {
  const index = await getListingSlugIndex();
  const resolution = resolveListingParam(index, param);
  if (resolution.kind !== "id" || index.idToSlug.size > 0) return resolution;
  const token = listingTokenOfParam(param);
  if (!isMintedListingIdToken(token)) return resolution;
  const hit = await liveListingForIdToken(token);
  if (!hit) return resolution;
  return hit.slug === param.trim() ? { kind: "slug", id: hit.id } : { kind: "stale", slug: hit.slug, id: hit.id };
});

/** The public URL of one listing, readable when it has a slug, the id URL otherwise. Never throws. */
export async function buildReadableListingUrl(origin: string, propertyId: string): Promise<string> {
  const index = await getListingSlugIndex();
  return `${origin.replace(/\/$/, "")}${listingPublicPath(propertyId, index.idToSlug.get(propertyId.trim()))}`;
}
