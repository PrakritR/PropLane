import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";

/**
 * Per-instance snapshots of facts about ONE manager that are identical for every viewer who asks.
 *
 * A single portal request fans out into dozens of plan / entitlement reads (one purchase row + one Auth admin
 * lookup per owner, per helper, per request; React `cache()` only dedupes inside one render). These facts do not
 * depend on WHO is asking, so one short-lived answer per instance, with one shared in-flight read, is the same
 * answer every viewer would have computed. What is NOT here, on purpose: anything scoped to the viewer
 * (`profile_roles`, `account_link_invites` seats, workspace membership, "which houses may I see"). Authorization
 * is always re-derived per request.
 *
 * Rules (AGENTS.md § Performance & egress): TTL at or under a minute, never cache a failure, never cache a
 * "no such row" answer (a signup or a first checkout writes exactly that row and must be seen at once), and every
 * writer that changes the underlying rows in this instance calls {@link invalidateManagerFactCaches}. Other
 * instances converge within the TTL, the same contract as `manager-tier-sync-cache.ts`.
 *
 * This module imports nothing server-only, so the writers' own cache modules can call the invalidator.
 */
export const MANAGER_FACT_TTL_MS = 30_000;
const MAX_PURCHASE_ROWS = 500;

/** Tests read live mocks on every call; set this to exercise the caches themselves. */
export function managerFactCachesEnabled(): boolean {
  return serverSnapshotCacheEnabled() || process.env.MANAGER_FACT_CACHE_IN_TEST === "1";
}

/** Carries an answer that must be returned to the caller but never stored. */
class Uncached<T> {
  constructor(readonly value: T) {}
}

const purchaseRows = createTtlCache<unknown>(MANAGER_FACT_TTL_MS, Date.now, { maxEntries: MAX_PURCHASE_ROWS });
const dedicatedWorkspaces = createTtlCache<unknown>(MANAGER_FACT_TTL_MS);
/** Owners of a working number in the stored dedicated set: only their plan can change it. Null = unknown. */
let dedicatedNumberOwners: ReadonlySet<string> | null = null;
let dedicatedEpoch = 0;
let dedicatedLoadsInFlight = 0;

function clearDedicatedWorkspaces(): void {
  dedicatedEpoch += 1;
  dedicatedNumberOwners = null;
  dedicatedWorkspaces.clear();
}

async function remember<T>(
  cache: { get(key: string, load: () => Promise<unknown>): Promise<unknown> },
  key: string,
  load: () => Promise<{ value: T; cacheable: boolean }>,
): Promise<T> {
  try {
    return (await cache.get(key, async () => {
      const result = await load();
      if (!result.cacheable) throw new Uncached(result.value);
      return result.value;
    })) as T;
  } catch (error) {
    if (error instanceof Uncached) return error.value as T;
    throw error;
  }
}

/** One manager's resolved purchase row view. `cacheable: false` for a failed read or an account with no row yet. */
export function rememberManagerPurchaseRow<T>(
  userId: string,
  load: () => Promise<{ value: T; cacheable: boolean }>,
): Promise<T> {
  if (!managerFactCachesEnabled()) return load().then((r) => r.value);
  return remember<T>(purchaseRows, userId, load);
}

/** What the dedicated-set load found: the workspaces, and every owner of a working number it judged by plan. */
export type DedicatedWorkspaceSnapshot = { workspaceIds: string[]; numberOwnerIds: string[] };

/** The workspaces that text from a working, PAID number of their own (global; the same for every caller). */
export async function rememberDedicatedWorkspaceIds(
  load: () => Promise<DedicatedWorkspaceSnapshot | null>,
): Promise<string[] | null> {
  if (!managerFactCachesEnabled()) return (await load())?.workspaceIds ?? null;
  // `null` is "could not read": handed back, never stored.
  return remember<string[] | null>(dedicatedWorkspaces, "all", async () => {
    const epoch = dedicatedEpoch;
    dedicatedLoadsInFlight += 1;
    try {
      const snapshot = await load();
      if (snapshot && epoch === dedicatedEpoch) dedicatedNumberOwners = new Set(snapshot.numberOwnerIds);
      return { value: snapshot?.workspaceIds ?? null, cacheable: snapshot !== null };
    } finally {
      dedicatedLoadsInFlight -= 1;
    }
  });
}

/** Drops one account's cached purchase row (its plan was reconciled or rewritten). Nothing else is disturbed. */
export function invalidateManagerPurchaseRow(userId: string): void {
  const id = userId.trim();
  if (id) purchaseRows.delete(id);
}

/**
 * A change to one account's plan: its row, and the global "who texts from a paid number of their own" snapshot
 * when that account owns a working number in it (or the snapshot's owners are not known yet).
 */
export function invalidateManagerPlanFacts(userId: string): void {
  const id = userId.trim();
  invalidateManagerPurchaseRow(id);
  if (dedicatedLoadsInFlight > 0 || dedicatedNumberOwners === null || dedicatedNumberOwners.has(id)) {
    clearDedicatedWorkspaces();
  }
}

/** Drops every cached manager fact (and detaches in-flight loads). Writers call this after the write lands. */
export function invalidateManagerFactCaches(): void {
  purchaseRows.clear();
  clearDedicatedWorkspaces();
}
