/**
 * The public catalog's per-listing contact fields, shared by the listing CTA
 * hooks (SMS phone and work email). One TTL cache and one in-flight request:
 * each hook used to keep its own cache with no in-flight guard, so a page that
 * mounted both hooks twice downloaded the whole public catalog four times.
 */
export type PublicListingContact = { contactSmsPhone?: string; contactWorkEmail?: string };

const CACHE_TTL_MS = 55_000;

let cache: { at: number; byId: Map<string, PublicListingContact> } | null = null;
let inFlight: Promise<Map<string, PublicListingContact> | null> | null = null;

async function fetchPublicListingContacts(): Promise<Map<string, PublicListingContact> | null> {
  try {
    const res = await fetch("/api/property-records/public", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { listings?: Array<{ id?: string } & PublicListingContact> };
    const byId = new Map<string, PublicListingContact>();
    for (const listing of body.listings ?? []) {
      const id = listing.id?.trim();
      if (id) byId.set(id, { contactSmsPhone: listing.contactSmsPhone, contactWorkEmail: listing.contactWorkEmail });
    }
    cache = { at: Date.now(), byId };
    return byId;
  } catch {
    return null;
  }
}

/** The listing's public contact fields, or null when it isn't in the catalog (or the read failed). */
export async function publicListingContact(listingId: string): Promise<PublicListingContact | null> {
  if (!cache || Date.now() - cache.at >= CACHE_TTL_MS) {
    inFlight ??= fetchPublicListingContacts().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }
  return cache?.byId.get(listingId) ?? null;
}

/** Tests only: forget the cached catalog. */
export function resetPublicListingContactsCache() {
  cache = null;
  inFlight = null;
}
