import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { homeLabelWithCity, matchListingsNamedIn } from "@/lib/one-number/house-redirect";
import { paidWorkNumberFor } from "@/lib/one-number/self-serve-line.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";
import { getPublicListings } from "@/lib/public-listings.server";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { getServicePublicListings, loadServiceWorkspaceIds } from "@/lib/service/service-catalog.server";

/**
 * Someone texting the PropLane line about a specific home that belongs to a workspace PropLane does not manage (a
 * SELF-SERVE home), matched by street address, house name or listing title. The line never answers for another team's home:
 *
 *   the home's manager PAYS for a work number   "For 12 Elm St, Louisville, text (502) 555-0142."  Nothing else about the home.
 *   no paid number (none, a signup trial, a lapsed plan, or one that could not be read)
 *                                                "I can only help with homes PropLane manages. ..."  Nothing about the home:
 *                                                no street, no link, no name, not even that it exists.
 *
 * `managerPersonalNumberEntitlement` is the one answer to "paid". Seam: runs on the PropLane line only, before the lead
 * qualifier or the leasing agent. A PropLane-managed home (matched in the service catalog first), no match, or any
 * unreadable read returns null and the existing flow answers exactly as before (that flow's catalog is the managed homes
 * only, so it has nothing to say about a self-serve home either).
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
  /** The work number the home's manager PAYS for (never the shared line), or null. */
  paidNumberOf?: (listing: MockProperty) => Promise<string | null>;
};

/** What the line says about a self-serve home whose manager has no paid work number. It names nothing. */
export const NO_PAID_NUMBER_HOME_REPLY = "I can only help with homes PropLane manages. Looking for a place in Seattle? Tell me your area, budget and move-in date.";

/** "For 12 Elm St, Louisville, text (502) 555-0142." Exported for tests. */
export function buildPaidHomeReply(input: { listing: Pick<MockProperty, "address">; number: string }): string {
  return toGsm7(`For ${homeLabelWithCity(input.listing)}, text ${formatUsPhoneDisplay(input.number)}.`);
}

export async function resolveHouseRedirect(db: SupabaseClient, text: string, depsIn: HouseRedirectDeps = {}): Promise<string | null> {
  try {
    if (!text.trim()) return null;
    const service = await (depsIn.serviceListings ?? (() => getServicePublicListings(db)))();
    // A PropLane-managed home is answered by the line itself, exactly as before.
    if (matchListingsNamedIn(text, service).kind !== "none") return null;
    const all = await (depsIn.allListings ?? allPublicListings)();
    const serviceIds = new Set(await (depsIn.serviceWorkspaceIds ?? (() => loadServiceWorkspaceIds(db)))());
    const candidates = all.filter((p) => !(p.workspaceId && serviceIds.has(p.workspaceId)));
    const match = matchListingsNamedIn(text, candidates);
    if (match.kind === "none") return null;
    // Several self-serve homes at once: nothing is named, nothing is guessed.
    if (match.kind === "several") return NO_PAID_NUMBER_HOME_REPLY;
    const listing = match.listing;
    const number = await (depsIn.paidNumberOf ??
      (async (l: MockProperty) => (l.managerUserId ? paidWorkNumberFor(db, { ownerUserId: l.managerUserId, workspaceId: l.workspaceId ?? null }) : null)))(listing).catch(() => null);
    return number ? buildPaidHomeReply({ listing, number }) : NO_PAID_NUMBER_HOME_REPLY;
  } catch (error) {
    console.error("house redirect failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
