import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { extractAddress } from "@/lib/one-number/onboarding/role-detect";
import { resolveSeattlePlace, matchHomeToPlace, zipAreaLabel, type ResolvedPlace } from "@/lib/places/seattle-places";
import { publicServiceProjection } from "@/lib/public-service-projection";
import { loadOpenBoardCandidates } from "@/lib/service-work-board.server";
import {
  resolveWorkOrderPropertyZips,
  vendorMatchesZip,
  workOrderCategoryForMarketplace,
  type DirectoryProfileRow,
} from "@/lib/work-order-marketplace-match.server";
import { vendorCapabilitiesMatchCategory } from "@/lib/work-order-taxonomy";

/**
 * "Any jobs near me?" over the Find work board (docs/agents/one-number.md, W24). The SAME candidate read and the SAME
 * allowlist projection the signed-in board uses (`loadOpenBoardCandidates`, `publicServiceProjection`): published,
 * unassigned, still-open services only, and a general area (city + zip neighborhood), never a street, unit, resident,
 * price the manager did not publish or internal id. A texter with no account has no profile, so the area they NAME
 * (a Seattle place or zip, `resolveSeattlePlace`) and the trade they name are the filters; a known vendor's saved
 * trades and service area fill in whatever they leave out.
 */

export type OpenJobNear = {
  title: string;
  /** "Plumbing" */
  trade: string;
  /** "Ballard": the neighborhood, or the city when the zip is not in the place table, or "Nearby". Never a zip. */
  area: string;
  when: string;
  /** "Up to $250" when the manager published a budget, else "". */
  budget: string;
  distanceMiles: number | null;
};

export type OpenJobsNear = {
  jobs: OpenJobNear[];
  /** Matches before the cut to `limit`. */
  total: number;
  /** The place the texter named, or null. */
  place: ResolvedPlace | null;
  /** True when an area filter was applied (a named place, or a known vendor's own service area). */
  filteredByArea: boolean;
};

export const OPEN_JOBS_REPLY_LIMIT = 4;

/** A manager's title may carry the street ("Leaky tap at 123 Main St"): the text keeps the work, drops the address. */
export function titleWithoutAddress(title: string, trade: string): string {
  const address = extractAddress(title);
  let out = address ? title.replace(address, "") : title;
  // extractAddress only knows common street words. Whatever it misses: a house number with its street name
  // ("1420 Alder", "88 N Pike"), a unit, a zip, never reaches a stranger's phone.
  out = out
    .replace(/\b\d{3,6}[a-z]?\s+(?:[NSEW]{1,2}\.?\s+)?[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,2}/g, "")
    .replace(/(?:\b(?:apt|apartment|unit|suite|ste|room|rm)\.?\s*|#\s*)[A-Za-z0-9-]+/gi, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "");
  out = out.replace(/\b(at|@|for|on)\s*$/i, "").replace(/\s{2,}/g, " ").replace(/[\s,;:-]+$/g, "").trim();
  return out.length >= 3 ? out : trade;
}

/** "Ballard (98107)" -> "Ballard"; "the University District (98105)" -> "University District". A zip is never part of the area. */
export function neighborhoodOnly(label: string | null | undefined): string | null {
  const out = String(label ?? "")
    .replace(/\(?\b\d{5}(?:-\d{4})?\b\)?/g, "")
    .replace(/^the\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:-]+$/g, "")
    .trim();
  return out || null;
}

export async function listOpenJobsNear(
  db: SupabaseClient,
  input: {
    /** One of VENDOR_TRADE_OPTIONS ("Plumbing", "General maintenance"...), or null for any trade. */
    tradeLabel?: string | null;
    /** Free text that may name a Seattle place or zip ("near Ballard", "98115"). */
    areaText?: string | null;
    /** A signed-in vendor: their saved trades / service area apply when the text names none, and held offers are skipped. */
    vendor?: { userId: string; profile: DirectoryProfileRow | null } | null;
    limit?: number;
  },
): Promise<OpenJobsNear> {
  const limit = Math.min(Math.max(1, input.limit ?? OPEN_JOBS_REPLY_LIMIT), 10);
  const place = input.areaText ? resolveSeattlePlace(input.areaText) : null;
  const loaded = await loadOpenBoardCandidates(db as never);
  if (!loaded.ok) throw new Error(loaded.error);

  const held = new Set<string>();
  if (input.vendor?.userId) {
    const { data } = await db.from("work_order_vendor_offers").select("work_order_id").eq("vendor_user_id", input.vendor.userId);
    for (const offer of (data ?? []) as { work_order_id: unknown }[]) held.add(String(offer.work_order_id));
  }

  const profile = input.vendor?.profile ?? null;
  const tradeLabels = input.tradeLabel ? [input.tradeLabel] : Array.isArray(profile?.trades) ? (profile!.trades as string[]) : [];
  const useProfileArea = !place && Boolean(profile && (profile.service_area_zips ?? []).length > 0);
  const filteredByArea = Boolean(place) || useProfileArea;

  // One property read for the whole board, not one per service.
  const open = loaded.candidates.filter((record) => !held.has(String(record.id)));
  const zips = await resolveWorkOrderPropertyZips(db, open.map((record) => (record.row_data ?? {}) as DemoManagerWorkOrderRow));
  const matched: { job: OpenJobNear; sort: number }[] = [];
  for (const [index, record] of open.entries()) {
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    const category = workOrderCategoryForMarketplace(row, row.category ?? "Maintenance");
    if (tradeLabels.length > 0 && (!category || !vendorCapabilitiesMatchCategory(tradeLabels, category))) continue;
    const zip = zips[index] ?? null;
    let distance: number | null = null;
    if (place) {
      const match = zip ? matchHomeToPlace({ zip }, place) : null;
      if (!match || !match.near) continue;
      distance = match.distanceMiles;
    } else if (useProfileArea) {
      if (!zip || !vendorMatchesZip(zip, 25, profile!)) continue;
    }
    const view = publicServiceProjection(row, "");
    const zipLabel = neighborhoodOnly(zipAreaLabel(zip));
    matched.push({
      job: {
        title: titleWithoutAddress(view.title, view.trade),
        trade: view.trade,
        area: zipLabel ?? neighborhoodOnly(view.area) ?? "Nearby",
        when: view.when,
        budget: view.budget,
        distanceMiles: distance,
      },
      sort: distance ?? Number.MAX_SAFE_INTEGER,
    });
  }
  // Nearest first when a place was named; otherwise the board's own order (newest first) holds.
  if (place) matched.sort((a, b) => a.sort - b.sort);
  return { jobs: matched.slice(0, limit).map((m) => m.job), total: matched.length, place, filteredByArea };
}
