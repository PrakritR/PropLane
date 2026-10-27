import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { homeLabelWithCity, matchListingsNamedIn } from "@/lib/one-number/house-redirect";
import { sharedLineCatalogListings } from "@/lib/one-number/line-catalog.server";
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
 * qualifier or the leasing agent.
 *
 * SHARED mode (`deps.shared`): the 206 is every free or trial manager's work number, so a self-serve home with no personal
 * number is SERVED by the line (it is in the line catalog, `line-catalog.server.ts`) and gets no redirect and no "I can only
 * help with homes PropLane manages" reply. A home whose workspace holds a personal number is NOT redirected here any more:
 * a mention alone says nothing. The lead flow gives that manager's number (with their first name) only when the prospect
 * expresses interest - a pick, a yes to the switch question, or a text that names the home - and writes only that interest
 * and the reply into their Communication (`paidInterestTurn`). Shared mode therefore always returns null here. A
 * PropLane-managed home, no match, or any unreadable read returns null and the existing flow answers exactly as before.
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
  /** The line config when the line is in `shared` mode. Omitted (or any other mode) = the per_workspace rules above. */
  shared?: SharedLineConfig | null;
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
    const service = await (
      depsIn.serviceListings ??
      (() => (depsIn.shared?.mode === "shared" ? sharedLineCatalogListings(db, depsIn.shared) : getServicePublicListings(db)))
    )();
    // A PropLane-managed home is answered by the line itself, exactly as before.
    if (matchListingsNamedIn(text, service).kind !== "none") return null;
    const all = await (depsIn.allListings ?? allPublicListings)();
    const paidNumberOf =
      depsIn.paidNumberOf ??
      (async (l: MockProperty) => {
        // The number must be the one the home's OWN workspace sends from. A listing the migration never placed has no
        // workspace, and a null workspace resolves the owner's DEFAULT line - naming it would send the texter to
        // another workspace's inbox, so such a home is simply not named.
        const workspaceId = String(l.workspaceId ?? "").trim();
        if (!l.managerUserId || !workspaceId) return null;
        return paidWorkNumberFor(db, { ownerUserId: l.managerUserId, workspaceId });
      });
    if (depsIn.shared?.mode === "shared") {
      // A home whose manager has a personal number is no longer answered on a MERE MENTION. The lead flow
      // (`unassigned-leads.server.ts`) locks the texter to the home they pick or name and gives the manager's number only on
      // expressed interest (a pick, a yes to the switch question, a text naming the home); see `paidInterestTurn`.
      return null;
    }
    const serviceIds = new Set(await (depsIn.serviceWorkspaceIds ?? (() => loadServiceWorkspaceIds(db)))());
    const candidates = all.filter((p) => !(p.workspaceId && serviceIds.has(p.workspaceId)));
    const match = matchListingsNamedIn(text, candidates);
    if (match.kind === "none") return null;
    // Several self-serve homes at once: nothing is named, nothing is guessed.
    if (match.kind === "several") return NO_PAID_NUMBER_HOME_REPLY;
    const listing = match.listing;
    const number = await paidNumberOf(listing).catch(() => null);
    return number ? buildPaidHomeReply({ listing, number }) : NO_PAID_NUMBER_HOME_REPLY;
  } catch (error) {
    console.error("house redirect failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
