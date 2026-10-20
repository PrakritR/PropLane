import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { readPlatformServiceOwnerIdOrThrow } from "@/lib/service/service-catalog.server";
import { createTtlCache, serverSnapshotCacheEnabled, type TtlCache } from "@/lib/server-ttl-cache";
import { toChain, vendorTradeIds, type VendorRecord } from "@/lib/vendor-dispatch/match.server";
import { vendorDispatchRoles } from "@/lib/vendor-dispatch/vendor-roles";
import type { ChainVendor } from "@/lib/vendor-dispatch/types";

/**
 * PropLane Service roster x the dispatch engine (captain, Oct 19).
 *
 * A PropLane Service workspace (`portal_workspaces.is_service`) is offered work the same way as any other, through the
 * one dispatch engine (runs, attempts, YES / NO / BUSY / DONE, general-area-only offer text, approval). The only
 * difference is WHO is asked: the workspace's own vendors plus the service-wide ROSTER an admin keeps in Admin > Service
 * > Vendors (`manager_vendor_records` rows owned by the service owner with `row_data.serviceRoster = true`).
 *
 * Roster vendors are texted from the PropLane line (the service owner's number, or the shared line while it is live),
 * so their consent, STOP and replies live under the SERVICE OWNER, and the job's approver is the service manager.
 * Nothing here applies to a workspace without the `is_service` flag.
 */

export type RosterRowData = ManagerVendorRow & { serviceRoster?: boolean; rosterRemovedAt?: string };

/**
 * The two roster lookups are repeated once per stay by the turnover sweep (every 2 minutes) and again by the approval
 * check, and both are PUBLIC facts - the workspace's service flag and which trades the roster covers - identical for
 * every caller. `createTtlCache` is the repo's helper for exactly that: one answer per instance, one in-flight read
 * shared, a failure never cached, and off under test so the reads under test stay live.
 */
const LOOKUP_TTL_MS = 30_000;
const serviceOwnerCache = createTtlCache<string | null>(LOOKUP_TTL_MS);
const rosterTradeCache = createTtlCache<ReadonlySet<string>>(LOOKUP_TTL_MS);

async function snapshot<T>(cache: TtlCache<T>, key: string, load: () => Promise<T>): Promise<T> {
  return serverSnapshotCacheEnabled() ? cache.get(key, load) : load();
}

/** Tests only: drop both snapshots so one case's warm answer is not another's. */
export function resetServiceRosterCaches(): void {
  serviceOwnerCache.clear();
  rosterTradeCache.clear();
}

/** The service owner's id when `workspaceId` is a PropLane Service workspace; null for every other workspace or any failed read. */
export async function serviceOwnerForWorkspace(db: SupabaseClient, workspaceId: string | null | undefined): Promise<string | null> {
  const id = workspaceId?.trim();
  if (!id) return null;
  try {
    // The loader THROWS on a failed read so the cache never keeps the failure; the caller still sees null.
    return await snapshot(serviceOwnerCache, id, async () => {
      const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message || "workspace read failed");
      if ((data as { is_service?: unknown } | null)?.is_service !== true) return null;
      // The OrThrow read: `readPlatformServiceOwnerId` folds its own failure into null, and a null cached for 30s
      // reads as "not a service workspace" - which hands the approval back to the view-only client.
      return await readPlatformServiceOwnerIdOrThrow(db);
    });
  } catch {
    return null;
  }
}

/**
 * `serviceOwnerForWorkspace` for a caller that must not mistake a failed read for "not a service workspace" (the
 * approval-code gate): it throws when either read fails, and is never cached.
 */
export async function serviceOwnerForWorkspaceOrThrow(db: SupabaseClient, workspaceId: string | null | undefined): Promise<string | null> {
  const id = workspaceId?.trim();
  if (!id) return null;
  const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message || "workspace read failed");
  if ((data as { is_service?: unknown } | null)?.is_service !== true) return null;
  return readPlatformServiceOwnerIdOrThrow(db);
}

/** A live roster entry: flagged, active, not removed. (Pause is checked separately: it is a dispatch filter.) */
export function isLiveRosterRow(row: RosterRowData | null | undefined): boolean {
  return Boolean(row && row.serviceRoster === true && row.active !== false && !row.rosterRemovedAt);
}

function areaScore(vendorArea: string | undefined, jobArea: string | null | undefined): number {
  const area = (jobArea ?? "").toLowerCase();
  const mine = (vendorArea ?? "").toLowerCase();
  if (!area || !mine) return 0;
  return mine
    .split(/[,;/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => area.includes(part) || part.includes(area))
    ? 1
    : 0;
}

/** Records of the roster that take `trade` (paused and removed entries are out); `null` = every live roster row. Not yet checked for consent. */
async function rosterRecordsForTrade(db: SupabaseClient, serviceOwnerId: string, trade: string | null): Promise<VendorRecord[]> {
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("manager_user_id", serviceOwnerId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as VendorRecord[]).filter((record) => {
    const row = record.row_data as RosterRowData | null;
    if (!isLiveRosterRow(row) || row!.dispatchAvailable === false) return false;
    if (trade === null) return true;
    return vendorDispatchRoles(row!).includes(trade as never) || vendorTradeIds(row!).has(trade);
  });
}

/**
 * The reachable roster vendors for a job, best fit first (a vendor whose area matches the job's general area leads).
 * Reachability is judged against the SERVICE OWNER, who is the sender: a STOPped number, a busy vendor or one with no
 * phone is not in the chain. Throws on a failed read (the caller then offers only the workspace's own vendors).
 */
export async function loadServiceRosterChain(
  db: SupabaseClient,
  input: { serviceOwnerId: string; trade: string; area?: string | null; at?: Date },
): Promise<ChainVendor[]> {
  const records = await rosterRecordsForTrade(db, input.serviceOwnerId, input.trade);
  const ordered = records
    .sort((a, b) => {
      const sa = areaScore((a.row_data as RosterRowData | null)?.serviceArea, input.area);
      const sb = areaScore((b.row_data as RosterRowData | null)?.serviceArea, input.area);
      return sb - sa || String(a.row_data?.name ?? "").localeCompare(String(b.row_data?.name ?? ""));
    });
  const byId = new Map(ordered.map((record) => [record.id, record] as const));
  return toChain(db, input.serviceOwnerId, ordered.map((record) => record.id), byId, input.at ?? new Date());
}

/**
 * Does the roster hold anyone for this trade? (Cheap predicate for "would this workspace dispatch".) The whole trade
 * SET is read once per owner and memoized, so the turnover sweep does not scan the roster once per stay.
 */
export async function serviceRosterHasTrade(db: SupabaseClient, serviceOwnerId: string, trade: string): Promise<boolean> {
  try {
    const trades = await snapshot(rosterTradeCache, serviceOwnerId, async () => {
      const records = await rosterRecordsForTrade(db, serviceOwnerId, null);
      const set = new Set<string>();
      for (const record of records) {
        const row = record.row_data as RosterRowData;
        for (const id of vendorDispatchRoles(row)) set.add(String(id));
        for (const id of vendorTradeIds(row)) set.add(id);
      }
      return set as ReadonlySet<string>;
    });
    return trades.has(trade);
  } catch {
    return false;
  }
}

/** Merge the roster behind the workspace's own chain, one entry per phone, positions renumbered. */
export function mergeRosterChain(own: ChainVendor[], roster: ChainVendor[]): ChainVendor[] {
  const seen = new Set(own.map((vendor) => vendor.phone));
  const merged = [...own];
  for (const vendor of roster) {
    if (seen.has(vendor.phone)) continue;
    seen.add(vendor.phone);
    merged.push(vendor);
  }
  return merged.map((vendor, index) => ({ ...vendor, position: index }));
}

/**
 * Is this directory id a live roster vendor of the service owner? The transport uses it to send the text AS the service
 * owner (their number, their consent ledger); the contact loader uses it to allow the row across the ownership check.
 */
export async function rosterSenderFor(
  db: SupabaseClient,
  vendorDirectoryId: string,
): Promise<{ serviceOwnerId: string } | null> {
  try {
    const { data, error } = await db
      .from("manager_vendor_records")
      .select("manager_user_id, row_data")
      .eq("id", vendorDirectoryId)
      .maybeSingle();
    if (error || !data) return null;
    const record = data as { manager_user_id?: string | null; row_data?: RosterRowData | null };
    if (record.row_data?.serviceRoster !== true || !record.manager_user_id) return null;
    const ownerId = await readPlatformServiceOwnerIdOrThrow(db);
    return ownerId && ownerId === record.manager_user_id ? { serviceOwnerId: ownerId } : null;
  } catch {
    return null;
  }
}

export type ServiceRosterVendor = Omit<ChainVendor, "position">;

/**
 * The dispatch path's hook for the service-wide roster (called from `fallbackChain`; `on/paycore` added the call site and
 * a stub, this is the body). The reachable roster vendors for a job of `trade` in `workspaceId`, best fit first. `[]` for any
 * workspace that is not a PropLane Service workspace, when nobody on the roster takes the trade, or when the roster cannot be
 * read: the caller then offers the workspace's own vendors only.
 */
export async function serviceRosterVendorsForTrade(
  db: SupabaseClient,
  input: { workspaceId: string; trade: string; area?: string | null; at?: Date },
): Promise<ServiceRosterVendor[]> {
  try {
    const serviceOwnerId = await serviceOwnerForWorkspace(db, input.workspaceId);
    if (!serviceOwnerId) return [];
    return await loadServiceRosterChain(db, { serviceOwnerId, trade: input.trade, area: input.area, at: input.at });
  } catch {
    return [];
  }
}
