import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { loadSharedLineConfig, workspaceHasDedicatedNumber, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { lineTierOf, type LineListing, type LineTier } from "@/lib/one-number/line-tier";
import { getPublicListings } from "@/lib/public-listings.server";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { getServicePublicListings, loadServiceWorkspaceIds } from "@/lib/service/service-catalog.server";

/**
 * The homes a stranger on the PropLane line is shown, by line mode.
 *
 *   per_workspace / shadow   the live homes of PropLane-managed (`is_service`) workspaces and nothing else
 *                            (`getServicePublicListings`); a self-serve manager has their own number.
 *   shared                   the 206 is every free or trial manager's work number, so the live public homes of every
 *                            workspace that answers on it: managed workspaces plus every self-serve workspace WITHOUT a
 *                            personal number (`workspaceOnSharedLine`: not dedicated, inside the pilot list when there
 *                            is one). A home whose workspace holds a PAID personal number is not here: its manager is
 *                            named in a redirect instead (`resolveHouseRedirect`).
 *
 * Always drawn from `getPublicListings` (the allowlisted public projection, never a raw row). Fails closed: a home with no
 * workspace id is not served, and an unreadable service-workspace list throws (the caller says "the team will follow up").
 */

const allCache = createTtlCache<MockProperty[]>(60_000);

async function allPublicListings(): Promise<MockProperty[]> {
  // The workspace id is opted in here only: tiering needs it, and a public response never carries it.
  const load = () => getPublicListings({ workspaceId: true });
  return serverSnapshotCacheEnabled() ? allCache.get("all", load) : load();
}

/** Tests only. */
export function resetLineCatalogCache(): void {
  allCache.clear();
}

export type LineCatalogDeps = {
  allListings?: () => Promise<MockProperty[]>;
  serviceWorkspaceIds?: () => Promise<string[]>;
};

/** The shared-mode catalog for an already-read config (no extra config read). */
export async function sharedLineCatalogListings(db: SupabaseClient, config: SharedLineConfig, deps: LineCatalogDeps = {}): Promise<MockProperty[]> {
  const all = await (deps.allListings ?? allPublicListings)();
  const serviceIds = new Set(await (deps.serviceWorkspaceIds ?? (() => loadServiceWorkspaceIds(db)))());
  return all.filter((p) => {
    const id = String(p.workspaceId ?? "").trim();
    if (!id) return false;
    return serviceIds.has(id) || workspaceOnSharedLine(config, id);
  });
}

/** The homes the line shows right now. Reads the line mode itself unless a config is passed. */
export async function getLineCatalogListings(db: SupabaseClient, config?: SharedLineConfig, deps: LineCatalogDeps = {}): Promise<MockProperty[]> {
  const cfg = config ?? (await loadSharedLineConfig(db));
  if (cfg.mode !== "shared") return getServicePublicListings(db);
  return sharedLineCatalogListings(db, cfg, deps);
}

// ---------------------------------------------------------------------------
// The stranger's OFFER catalog: the served homes plus paid managers' homes, each tagged with its tier
// ---------------------------------------------------------------------------

/**
 * Every public home a stranger can be OFFERED in shared mode: the served catalog (`sharedLineCatalogListings`) tagged
 * managed / free, plus the homes of workspaces that hold a personal number tagged paid. Still the allowlisted public
 * projection (`getPublicListings`), never a raw row; a home with no workspace stamp is out. Paid homes are offered only so
 * a prospect can SEE them: the line gives their manager's number on interest, never the home's details.
 */
export async function sharedLineOfferListings(db: SupabaseClient, config: SharedLineConfig, deps: LineCatalogDeps = {}): Promise<LineListing[]> {
  const all = await (deps.allListings ?? allPublicListings)();
  const serviceIds = new Set(await (deps.serviceWorkspaceIds ?? (() => loadServiceWorkspaceIds(db)))());
  const out: LineListing[] = [];
  for (const p of all) {
    const id = String(p.workspaceId ?? "").trim();
    if (!id) continue;
    if (serviceIds.has(id)) out.push({ ...p, lineTier: "managed" });
    else if (workspaceOnSharedLine(config, id)) out.push({ ...p, lineTier: "free" });
    else if (workspaceHasDedicatedNumber(config, id)) out.push({ ...p, lineTier: "paid" });
  }
  return out;
}

/** The homes a stranger is offered right now, tagged. per_workspace / shadow: the managed homes only, as before. */
export async function getLineOfferListings(db: SupabaseClient, config?: SharedLineConfig, deps: LineCatalogDeps = {}): Promise<LineListing[]> {
  const cfg = config ?? (await loadSharedLineConfig(db));
  if (cfg.mode !== "shared") return (await getServicePublicListings(db)).map((p) => ({ ...p, lineTier: "managed" as const }));
  return sharedLineOfferListings(db, cfg, deps);
}

export { lineTierOf, type LineListing, type LineTier };
