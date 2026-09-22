/**
 * The "you just published this" confirmation, handed across a route change.
 *
 * Publishing a draft moves the record out of the Drafts bucket, so the detail
 * page the manager finished the wizard on is no longer that record's URL — the
 * panel sends them to the Listed detail route instead. `[stage]` is a dynamic
 * segment, so that navigation REMOUNTS the page and any dialog state held on
 * the old page dies with it (the same invariant
 * `writePendingFirstListingAutoOpen` exists for). The page about to navigate
 * writes the listing here; the page that mounts on Listed takes it — once —
 * and shows `ListingPublishedDialog`.
 *
 * One slot, not one per listing: only ever one publish is in flight, and a
 * single slot cannot leave a stale marker behind to fire at some later
 * property. A take always clears it, so a reload never shows the dialog twice.
 */

const JUST_PUBLISHED_KEY = "proplane:listing-just-published";

export type JustPublishedListing = {
  /** The published listing's id — also the key of the detail route it lands on. */
  id: string;
  /** What the row was called when the manager pressed Publish. */
  name: string;
};

function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readSlot(): JustPublishedListing | null {
  try {
    const raw = sessionStore()?.getItem(JUST_PUBLISHED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<JustPublishedListing> | null;
    const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
    if (!id) return null;
    return { id, name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name : "Listing" };
  } catch {
    return null;
  }
}

export function writeJustPublishedListing(listing: JustPublishedListing): void {
  const id = listing.id.trim();
  if (!id) return;
  try {
    sessionStore()?.setItem(JUST_PUBLISHED_KEY, JSON.stringify({ id, name: listing.name }));
  } catch {
    /* storage refused; the manager simply lands on the listing with no dialog */
  }
}

/**
 * Is a publish redirect still in flight for this listing?
 *
 * Peeks without consuming, so the stage-correcting redirect can stand down
 * while the publish navigation it would otherwise race is still landing.
 */
export function hasJustPublishedListing(listingId: string): boolean {
  const id = listingId.trim();
  return Boolean(id) && readSlot()?.id === id;
}

/** Read AND clear. Returns the listing only when it is the one asked for. */
export function takeJustPublishedListing(listingId: string): JustPublishedListing | null {
  const id = listingId.trim();
  if (!id) return null;
  const slot = readSlot();
  if (!slot) return null;
  try {
    sessionStore()?.removeItem(JUST_PUBLISHED_KEY);
  } catch {
    /* ignore */
  }
  return slot.id === id ? slot : null;
}
