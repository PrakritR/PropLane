import { listingSubmissionStreetLine } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

export { LISTING_PATH_PREFIX, listingPublicPath } from "@/lib/listing-public-path";

/**
 * Readable listing URLs: `/rent/listings/4709a-8th-ave-ne` instead of `/rent/listings/<propertyId>`.
 *
 * The slug is DERIVED from the listing's current street address, never stored: no database id changes, an address
 * edit moves the slug, and the old id URL (and any older slug) keeps working through a permanent redirect. This module
 * is pure; the one server read that maps a slug back to an id is `src/lib/seo/listing-slugs.server.ts`.
 */

const MAX_SLUG_LENGTH = 80;
/** Appended to every slug in a colliding group: the last characters of the property id. */
const COLLISION_SUFFIX_LENGTH = 6;

/** Lower-case, accents folded, only a-z0-9 and single hyphens, no leading or trailing hyphen. */
export function slugifyAddress(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

type SlugListing = Pick<MockProperty, "id" | "address"> & Partial<Pick<MockProperty, "listingSubmission" | "zip" | "state" | "neighborhood">>;

/** The street line of the current address ("4709A 8th Ave NE"), without ", City, ST ZIP". Empty when there is none. */
function streetLineOf(listing: SlugListing): string {
  const address = (listing.address ?? "").trim();
  if (!address) return "";
  const submission = listing.listingSubmission?.v === 1 ? listing.listingSubmission : null;
  if (submission) {
    const street = listingSubmissionStreetLine({ ...submission, address });
    if (street) return street.split(",")[0]!.trim();
  }
  return address.split(",")[0]!.trim();
}

/**
 * The base slug for a listing: the slugified street address, or `null` when it has none (such a listing keeps its id URL).
 * Two listings can share it; `buildListingSlugIndex` is what makes the published slug unique.
 */
export function listingSlugFor(listing: SlugListing): string | null {
  const slug = slugifyAddress(streetLineOf(listing));
  return slug || null;
}

/** The last characters of an id, made slug-safe, that tell two same-address listings apart. */
export function listingIdSuffix(id: string): string {
  return slugifyAddress(id.trim().slice(-COLLISION_SUFFIX_LENGTH));
}

export type ListingSlugIndex = {
  /** property id -> its published slug (only listings that have one). */
  idToSlug: ReadonlyMap<string, string>;
  /** published slug -> property id. */
  slugToId: ReadonlyMap<string, string>;
};

export const EMPTY_LISTING_SLUG_INDEX: ListingSlugIndex = { idToSlug: new Map(), slugToId: new Map() };

/**
 * Slugs for a whole catalog. A base slug used by exactly one listing is the slug. When several PUBLISHED listings share one,
 * every one of them gets `-` plus the last six characters of its id, so the result is deterministic and never depends on
 * catalog order. A slug that is still shared after that (same id tail too) is dropped for all of its holders: those listings
 * keep their id URL rather than resolving to the wrong home.
 */
export function buildListingSlugIndex(listings: readonly SlugListing[]): ListingSlugIndex {
  const byBase = new Map<string, string[]>();
  const seenIds = new Set<string>();
  for (const listing of listings) {
    const id = listing.id?.trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const base = listingSlugFor(listing);
    if (!base) continue;
    const group = byBase.get(base);
    if (group) group.push(id);
    else byBase.set(base, [id]);
  }
  const candidates: Array<[string, string]> = [];
  for (const [base, ids] of byBase) {
    if (ids.length === 1) {
      candidates.push([ids[0]!, base]);
      continue;
    }
    for (const id of ids) {
      const suffix = listingIdSuffix(id);
      candidates.push([id, suffix ? `${base}-${suffix}` : base]);
    }
  }
  const holders = new Map<string, number>();
  for (const [, slug] of candidates) holders.set(slug, (holders.get(slug) ?? 0) + 1);
  const idToSlug = new Map<string, string>();
  const slugToId = new Map<string, string>();
  for (const [id, slug] of candidates) {
    if (holders.get(slug) !== 1 || seenIds.has(slug)) continue;
    idToSlug.set(id, slug);
    slugToId.set(slug, id);
  }
  return { idToSlug, slugToId };
}

export type ListingParamResolution =
  /** The param is a property id that has a slug: send the visitor to the slug URL (308). */
  | { kind: "redirect"; slug: string }
  /** The param is a published slug: render the property with this id. */
  | { kind: "slug"; id: string }
  /** Anything else (an id with no slug, an unpublished id, an unknown word): render as before; a miss is the existing not-found state. */
  | { kind: "id"; id: string };

/**
 * What a `/rent/listings/<param>` request is. An id wins over a slug of the same spelling: the id lookup
 * is first, and `buildListingSlugIndex` never publishes a slug that spells a property id, so the one
 * precedence rule is enforced in one place.
 */
export function resolveListingParam(index: ListingSlugIndex, param: string): ListingParamResolution {
  const value = param.trim();
  const slugOfId = index.idToSlug.get(value);
  if (slugOfId) return { kind: "redirect", slug: slugOfId };
  const idOfSlug = index.slugToId.get(value);
  if (idOfSlug) return { kind: "slug", id: idOfSlug };
  return { kind: "id", id: value };
}
