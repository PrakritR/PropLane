import { listingSubmissionStreetLine } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

import { LISTING_PATH_PREFIX } from "@/lib/listing-public-path";

export { LISTING_PATH_PREFIX, listingPublicPath } from "@/lib/listing-public-path";

/**
 * Readable listing URLs: `/rent/listings/4709a-8th-ave-ne` instead of `/rent/listings/<propertyId>`.
 *
 * The slug is DERIVED from the listing's current street address plus a stable token of its id, never stored: no database
 * id changes, an address edit moves only the readable part, and the old id URL (and any older slug) keeps working through
 * a permanent redirect. Resolution reads the trailing id token only, so a rename never breaks a link. This module
 * is pure; the one server read that maps a slug back to an id is `src/lib/seo/listing-slugs.server.ts`.
 */

const MAX_SLUG_LENGTH = 80;

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
 * The stable token of a property id. Ids minted by the app end in a random token (`...-7mdlyj0h2vfg`): that token is used
 * as is. An id without one (`prop-b-0001`, a hand-made id) gets `h` plus a 64-bit FNV hash of the whole id in base36, so the
 * token is always present, URL-safe, and depends on the id alone (never on the title, the address or the rest of the catalog).
 */
export function listingIdToken(id: string): string {
  const clean = id.trim().toLowerCase();
  const tail = clean.split("-").pop() ?? "";
  if (tail.length >= 8 && /^[a-z0-9]+$/.test(tail) && /\d/.test(tail) && /[a-z]/.test(tail)) return tail;
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
};

export const EMPTY_LISTING_SLUG_INDEX: ListingSlugIndex = { idToSlug: new Map(), tokenToId: new Map() };

/**
 * Canonical slugs for a whole catalog. Every listing gets `<street>-<id token>`, which depends on that listing alone, so
 * it is stable when another listing joins the catalog. A token held by two different ids (practically never) is dropped
 * for both: they keep their id URL rather than resolving to the wrong home.
 */
export function buildListingSlugIndex(listings: readonly SlugListing[]): ListingSlugIndex {
  const byToken = new Map<string, SlugListing[]>();
  const seenIds = new Set<string>();
  for (const listing of listings) {
    const id = listing.id?.trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const token = listingIdToken(id);
    const group = byToken.get(token);
    if (group) group.push(listing);
    else byToken.set(token, [listing]);
  }
  const idToSlug = new Map<string, string>();
  const tokenToId = new Map<string, string>();
  for (const [token, group] of byToken) {
    if (group.length !== 1) continue;
    const listing = group[0]!;
    idToSlug.set(listing.id.trim(), listingCanonicalSlug({ ...listing, id: listing.id.trim() }));
    tokenToId.set(token, listing.id.trim());
  }
  return { idToSlug, tokenToId };
}

export type ListingParamResolution =
  /** The param is an id or a stale slug: send the visitor to the canonical slug URL (308). */
  | { kind: "redirect"; slug: string; id: string }
  /** The param is exactly the canonical slug: render the property with this id. */
  | { kind: "slug"; id: string }
  /** Anything else (an unpublished id, an unknown word): render as before; a miss is the existing not-found state. */
  | { kind: "id"; id: string };

/**
 * What a `/rent/listings/<param>` request is. An exact record id wins (old links keep working and redirect to the
 * canonical path); otherwise the trailing id token picks the listing, whatever the title part says.
 */
export function resolveListingParam(index: ListingSlugIndex, param: string): ListingParamResolution {
  const value = param.trim();
  const slugOfId = index.idToSlug.get(value);
  if (slugOfId) return { kind: "redirect", slug: slugOfId, id: value };
  const idOfToken = index.tokenToId.get(listingTokenOfParam(value));
  if (idOfToken) {
    const slug = index.idToSlug.get(idOfToken)!;
    return value === slug ? { kind: "slug", id: idOfToken } : { kind: "redirect", slug, id: idOfToken };
  }
  return { kind: "id", id: value };
}
