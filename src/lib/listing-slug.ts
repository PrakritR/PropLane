import { listingSubmissionStreetLine } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

import { LISTING_PATH_PREFIX } from "@/lib/listing-public-path";

export { LISTING_PATH_PREFIX, listingPublicPath } from "@/lib/listing-public-path";

/**
 * Readable listing URLs: `/rent/listings/4709a-8th-ave-ne` instead of `/rent/listings/<propertyId>`.
 *
 * The slug is DERIVED from the listing's current street address plus a stable token of its id, never stored: no database
 * id changes, an address edit moves only the readable part, and an old id URL keeps working: the page renders that
 * listing in place and names the readable slug as its canonical. Resolution reads the trailing id token, so a rename
 * never breaks a link; a slug minted before the token
 * existed (the one form it was published under: `4709a-8th-ave-ne`, or `4709a-8th-ave-ne-<id tail>` when another
 * listing shared that street line) still resolves when exactly one listing owns it.
 * This module is pure; the one server read that maps a slug back to an id is `src/lib/seo/listing-slugs.server.ts`.
 */

const MAX_SLUG_LENGTH = 80;
/** The tail of the id the pre-token scheme appended to every listing in a group that shared one street line. */
const LEGACY_COLLISION_SUFFIX_LENGTH = 6;

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

/**
 * True when a segment is the random token an id minted by the app ends in (`7mdlyj0h2vfg`): long enough to be
 * unique, letters and digits only, and both present. The one shape `listingIdToken` takes as is, so the one shape
 * a slug's trailing segment can be matched back to an id by.
 */
export function isMintedListingIdToken(segment: string): boolean {
  const value = segment.trim().toLowerCase();
  return value.length >= 8 && /^[a-z0-9]+$/.test(value) && /\d/.test(value) && /[a-z]/.test(value);
}

/**
 * The stable token of a property id. Ids minted by the app end in a random token (`...-7mdlyj0h2vfg`): that token is used
 * as is. An id without one (`prop-b-0001`, a hand-made id) gets `h` plus a 64-bit FNV hash of the whole id in base36, so the
 * token is always present, URL-safe, and depends on the id alone (never on the title, the address or the rest of the catalog).
 */
export function listingIdToken(id: string): string {
  const clean = id.trim().toLowerCase();
  const tail = clean.split("-").pop() ?? "";
  if (isMintedListingIdToken(tail)) return tail;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ clean.length;
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return `h${h1.toString(36)}${h2.toString(36)}`.slice(0, 13);
}

/** The slug of one listing: readable street line (or `listing`) plus the stable id token. Pure: needs no catalog. */
export function listingCanonicalSlug(listing: SlugListing): string {
  const base = listingSlugFor(listing) ?? "listing";
  return `${base}-${listingIdToken(listing.id)}`;
}

/** The token a `/rent/listings/<param>` slug ends in (the title part is ignored on purpose, so a rename never breaks a link). */
export function listingTokenOfParam(param: string): string {
  return (param.trim().toLowerCase().split("-").pop() ?? "");
}

/** `/rent/listings/<street>-<id token>` for a listing in hand. Path only. The one builder every surface with the listing uses. */
export function listingPublicPathFor(listing: SlugListing): string {
  return `${LISTING_PATH_PREFIX}/${listingCanonicalSlug(listing)}`;
}

export type ListingSlugIndex = {
  /** property id -> its canonical slug. */
  idToSlug: ReadonlyMap<string, string>;
  /** id token -> property id (a token shared by two ids is left out of both maps). */
  tokenToId: ReadonlyMap<string, string>;
  /**
   * Legacy slug (minted before the id token) -> property id: the bare street line for a listing that owned it alone,
   * or the `<street>-<id tail>` form the old scheme gave each listing in a group that shared one. A key two listings
   * share is left out.
   */
  baseSlugToId: ReadonlyMap<string, string>;
};

export const EMPTY_LISTING_SLUG_INDEX: ListingSlugIndex = { idToSlug: new Map(), tokenToId: new Map(), baseSlugToId: new Map() };

/**
 * Canonical slugs for a whole catalog. Every listing gets `<street>-<id token>`, which depends on that listing alone, so
 * it is stable when another listing joins the catalog. A token held by two different ids (practically never) is dropped
 * for both: they keep their id URL rather than resolving to the wrong home.
 */
export function buildListingSlugIndex(listings: readonly SlugListing[]): ListingSlugIndex {
  const byToken = new Map<string, SlugListing[]>();
  const baseHolders = new Map<string, number>();
  const seenIds = new Set<string>();
  for (const listing of listings) {
    const id = listing.id?.trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const token = listingIdToken(id);
    const group = byToken.get(token);
    if (group) group.push(listing);
    else byToken.set(token, [listing]);
    const base = listingSlugFor(listing);
    if (base) baseHolders.set(base, (baseHolders.get(base) ?? 0) + 1);
  }
  const idToSlug = new Map<string, string>();
  const tokenToId = new Map<string, string>();
  const baseSlugOwners = new Map<string, string[]>();
  for (const [token, group] of byToken) {
    if (group.length !== 1) continue;
    const listing = group[0]!;
    const id = listing.id.trim();
    idToSlug.set(id, listingCanonicalSlug({ ...listing, id }));
    tokenToId.set(token, id);
    const base = listingSlugFor(listing);
    if (base) {
      const suffix = (baseHolders.get(base) ?? 1) > 1 ? slugifyAddress(id.slice(-LEGACY_COLLISION_SUFFIX_LENGTH)) : "";
      const published = suffix ? `${base}-${suffix}` : base;
      baseSlugOwners.set(published, [...(baseSlugOwners.get(published) ?? []), id]);
    }
  }
  // The slug scheme before the id token published ONE form per listing: the bare street line when it owned that line
  // alone, and `<street>-<last six characters of the id>` for each listing in a group that shared one. Whichever form
  // a listing had went out through the sitemap, texts, emails and syndicated posts, so that form resolves. A key two
  // listings share names neither: such a link keeps the not-found state.
  const baseSlugToId = new Map<string, string>();
  for (const [base, owners] of baseSlugOwners) if (owners.length === 1) baseSlugToId.set(base, owners[0]!);
  return { idToSlug, tokenToId, baseSlugToId };
}

export type ListingParamResolution =
  /** The param names this listing but is not its canonical slug (a record id, a slug minted before a rename):
   *  the page renders the listing and declares `slug` as its canonical URL. */
  | { kind: "stale"; slug: string; id: string }
  /** The param is exactly the canonical slug: render the property with this id. */
  | { kind: "slug"; id: string }
  /** Anything else (an unpublished id, an unknown word): render as before; a miss is the existing not-found state. */
  | { kind: "id"; id: string };

/**
 * What a `/rent/listings/<param>` request is. An exact record id wins (every link sent before slugs existed keeps
 * working); otherwise the trailing id token picks the listing, whatever the title part says; failing that, the legacy
 * slug the listing was published under before the token picks the one listing that owns it. No form redirects: the
 * page renders in place and names the canonical readable URL.
 */
export function resolveListingParam(index: ListingSlugIndex, param: string): ListingParamResolution {
  const value = param.trim();
  const slugOfId = index.idToSlug.get(value);
  if (slugOfId) return { kind: "stale", slug: slugOfId, id: value };
  const idOfToken = index.tokenToId.get(listingTokenOfParam(value));
  if (idOfToken) {
    const slug = index.idToSlug.get(idOfToken)!;
    return value === slug ? { kind: "slug", id: idOfToken } : { kind: "stale", slug, id: idOfToken };
  }
  const idOfBase = index.baseSlugToId.get(value.toLowerCase());
  if (idOfBase) return { kind: "stale", slug: index.idToSlug.get(idOfBase)!, id: idOfBase };
  return { kind: "id", id: value };
}
