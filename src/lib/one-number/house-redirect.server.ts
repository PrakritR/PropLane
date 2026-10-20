import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { buildDedicatedRedirectReply } from "@/lib/one-number/dedicated-redirect.server";
import { generalHomeLabel, matchListingByAddress } from "@/lib/one-number/house-redirect";
import { toGsm7 } from "@/lib/one-number/segments";
import { getPublicListings } from "@/lib/public-listings.server";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { getServicePublicListings, loadServiceWorkspaceIds } from "@/lib/service/service-catalog.server";

/**
 * Captain, Oct 20: someone texting the PropLane line about a specific home that belongs to a workspace PropLane does not
 * manage is sent to that workspace's own number when it has one (the PropLane line never answers for another team's home);
 * with no number of its own the reply is the home's public page and an offer of the homes PropLane manages.
 *
 * Seam: runs on the PropLane line only, before the lead qualifier or the leasing agent, and only for text that names a street
 * address which is NOT in the service catalog. A service home, no match, or any unreadable read returns null and the
 * existing flow answers exactly as before.
 */

const allCache = createTtlCache<MockProperty[]>(60_000);

async function allPublicListings(): Promise<MockProperty[]> {
  const load = () => getPublicListings();
  return serverSnapshotCacheEnabled() ? allCache.get("all", load) : load();
}

/** Tests only. */
export function resetHouseRedirectCache(): void {
  allCache.clear();
}

export type HouseRedirectDeps = {
  serviceListings?: () => Promise<MockProperty[]>;
  serviceWorkspaceIds?: () => Promise<string[]>;
  allListings?: () => Promise<MockProperty[]>;
  /** The workspace's OWN sendable number (never the shared line), or null. */
  ownNumberOf?: (listing: MockProperty) => Promise<string | null>;
  origin?: () => string;
};

/** The reply for a listing that is not PropLane-managed. Exported for tests. */
export function buildHouseRedirectReply(input: { listing: Pick<MockProperty, "id" | "address">; ownNumber: string | null; origin: string }): string {
  const label = generalHomeLabel(input.listing);
  if (input.ownNumber) return buildDedicatedRedirectReply(label, input.ownNumber);
  const link = `${input.origin.replace(/\/$/, "")}/rent/listings/${encodeURIComponent(input.listing.id)}`;
  return toGsm7(`${label} is listed here: ${link} PropLane also manages homes. Tell me your area, budget and move-in date and I will find one.`);
}

export async function resolveHouseRedirect(db: SupabaseClient, text: string, depsIn: HouseRedirectDeps = {}): Promise<string | null> {
  try {
    if (!/\d/.test(text)) return null;
    const service = await (depsIn.serviceListings ?? (() => getServicePublicListings(db)))();
    // A PropLane-managed home is answered by the line itself, exactly as before.
    if (matchListingByAddress(text, service)) return null;
    const all = await (depsIn.allListings ?? allPublicListings)();
    const serviceIds = new Set(await (depsIn.serviceWorkspaceIds ?? (() => loadServiceWorkspaceIds(db)))());
    const candidates = all.filter((p) => !(p.workspaceId && serviceIds.has(p.workspaceId)));
    const listing = matchListingByAddress(text, candidates);
    if (!listing) return null;
    const ownNumber = await (depsIn.ownNumberOf ??
      (async (l: MockProperty) =>
        l.managerUserId ? resolveActiveManagerSendNumber(db, l.managerUserId, l.workspaceId ?? null) : null))(listing).catch(() => null);
    return buildHouseRedirectReply({ listing, ownNumber, origin: (depsIn.origin ?? resolveEmailLinkBaseUrl)() });
  } catch (error) {
    console.error("house redirect failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
