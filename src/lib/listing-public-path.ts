/** Every public listing URL lives under this prefix (kept tiny: client code imports it). */
export const LISTING_PATH_PREFIX = "/rent/listings";

/** `/rent/listings/<slug>` when the listing has a published slug, else the id URL. Path only, no origin. */
export function listingPublicPath(propertyId: string, slug?: string | null): string {
  const tail = slug && slug.trim() ? slug.trim() : encodeURIComponent(propertyId.trim());
  return `${LISTING_PATH_PREFIX}/${tail}`;
}
