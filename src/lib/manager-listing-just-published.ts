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
 * Storage is the HANDOFF, never the live state: the mount that takes the marker
 * copies it into React state and clears the slot immediately, so everything
 * downstream reads one value that a dismiss can clear. Leaving the decision in
 * storage wedged the panel's own stage correction, which cannot re-run when a
 * key it never depends on quietly changes underneath it.
 *
 * Two guards keep a marker from outliving the navigation it was written for:
 * one slot (a second publish overwrites the first rather than queueing), and a
 * short expiry — the landing mount happens in the next frame, so anything older
 * than {@link JUST_PUBLISHED_TTL_MS} belongs to a journey that was abandoned.
 */

const JUST_PUBLISHED_KEY = "proplane:listing-just-published";

/**
 * How long a written marker still counts. The `router.replace` it accompanies
 * lands within a frame; this is slack for a slow route transition, not a
 * window in which some later visit may pick the marker up.
 */
export const JUST_PUBLISHED_TTL_MS = 30_000;

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

function clearSlot(): void {
  try {
    sessionStore()?.removeItem(JUST_PUBLISHED_KEY);
  } catch {
    /* ignore */
  }
}

function readSlot(): JustPublishedListing | null {
  let raw: string | null | undefined;
  try {
    raw = sessionStore()?.getItem(JUST_PUBLISHED_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: (Partial<JustPublishedListing> & { at?: unknown }) | null = null;
  try {
    parsed = JSON.parse(raw) as (Partial<JustPublishedListing> & { at?: unknown }) | null;
  } catch {
    clearSlot();
    return null;
  }
  const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
  const at = typeof parsed?.at === "number" ? parsed.at : 0;
  if (!id || !at || Date.now() - at > JUST_PUBLISHED_TTL_MS) {
    clearSlot();
    return null;
  }
  return { id, name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name : "Listing" };
}

export function writeJustPublishedListing(listing: JustPublishedListing): void {
  const id = listing.id.trim();
  if (!id) return;
  try {
    sessionStore()?.setItem(JUST_PUBLISHED_KEY, JSON.stringify({ id, name: listing.name, at: Date.now() }));
  } catch {
    /* storage refused; the manager simply lands on the listing with no dialog */
  }
}

/**
 * Read WITHOUT consuming — for seeding state on the very first render, before
 * any effect has run. Returns the listing only when it is the one asked for.
 * Safe to call twice (React double-renders in development).
 */
export function peekJustPublishedListing(listingId: string): JustPublishedListing | null {
  const id = listingId.trim();
  if (!id) return null;
  const slot = readSlot();
  return slot && slot.id === id ? slot : null;
}

/**
 * Read AND clear. Returns the listing only when it is the one asked for — but
 * clears either way, so a marker whose navigation never landed cannot sit in
 * storage waiting for some unrelated later visit.
 */
export function takeJustPublishedListing(listingId: string): JustPublishedListing | null {
  const id = listingId.trim();
  if (!id) return null;
  const slot = readSlot();
  if (!slot) return null;
  clearSlot();
  return slot.id === id ? slot : null;
}

/** Drop any pending marker — for a mount that is not a property detail page. */
export function clearJustPublishedListing(): void {
  clearSlot();
}
