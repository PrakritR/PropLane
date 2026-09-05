import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { MANAGER_PROPERTY_LIMIT_ERROR_CODE } from "@/lib/manager-access";
import type { MockProperty } from "@/data/types";
import { migrateAmenityOffersPropertyId } from "@/lib/manager-amenity-catalog-storage";
import type { PropertyPipelineSnapshot, ManagerPropertyRecordStatus } from "@/lib/persisted-property-records";
import { scopePropertyPipelineSnapshotForViewer } from "@/lib/persisted-property-records";
import type { ManagerListingSubmissionV1, ManagerListingServiceOption } from "@/lib/manager-listing-submission";
import { listingSubmissionLocationLabel } from "@/lib/manager-listing-submission";
import { parseRecordOfArrays } from "@/lib/safe-local-storage";
import { PROPERTY_PIPELINE_EVENT, serverSyncOriginatedEvent } from "@/lib/property-pipeline-events";
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";

/** Admin-only / legacy listings not tied to a real manager auth user (demo localStorage bucket). */
export const LEGACY_MANAGER_SCOPE_USER_ID = "__axis_legacy__";

/** Admin UI row shape (see demo-admin-property-inventory) — maps to pending row for publishing. */
export type ManagerAdminShapeRow = {
  adminRefId: string;
  buildingName: string;
  unitLabel: string;
  address: string;
  zip: string;
  neighborhood: string;
  beds: number;
  baths: number;
  monthlyRent: number;
  petFriendly: boolean;
  tagline: string;
};

const PENDING_BY_USER_KEY = "axis_manager_pending_by_user_v1";
const EXTRAS_BY_USER_KEY = "axis_manager_extras_by_user_v1";

/** Pre–per-account migration (single global arrays) — reserved for future migration helpers. */

// Re-export from the leaf module so existing `@/lib/demo-property-pipeline`
// import sites keep working, while the constant itself lives cycle-free.
export { PROPERTY_PIPELINE_EVENT };
const memoryStore = new Map<string, unknown>();
const SESSION_CACHE_PREFIX = "axis_property_pipeline_cache_v1:";
const PROPERTY_PIPELINE_SYNC_META_KEY = `${SESSION_CACHE_PREFIX}__synced_at`;
const PROPERTY_PIPELINE_SYNC_TTL_MS = 15_000;
let propertyPipelineSyncPromise: Promise<boolean> | null = null;
// Forced syncs bypass the TTL by design, so several panels mounting at once each
// used to issue their own `/api/property-records` fetch (measured: 5 on one
// `/portal/properties` load). The refreshers below collapse those into at most
// two, without ever handing a forced caller a fetch that started before it asked.
// Keyed by the viewer id because that id SCOPES the snapshot — an unscoped call
// and a scoped one must never share a run.
const propertyPipelineRefreshers = new Map<string, CoalescedRefresher<boolean>>();
// Linked property ids accumulated from every caller queued for the next run of a
// given viewer, drained when that run starts. A run must scope with the UNION of
// its callers' ids, never just the last one's: several call sites force a sync
// with no ids at all, and letting one of those win drops a joined caller's ids —
// which is exactly how `runPropertyPipelineSync` wipes co-managed owner buckets.
const pendingPipelineLinkedIds = new Map<string, Set<string>>();
// Signature of the last snapshot we broadcast. The PROPERTY_PIPELINE_EVENT re-enters
// listeners that can force another sync (e.g. manager-properties' refreshPortfolio),
// so dispatching on every sync — even an unchanged one — is an infinite refetch loop.
// Mirrors the change-guard in pro-relationships.ts.
let lastPipelineSnapshotSig: string | null = null;

export type ManagerPendingPropertyRow = {
  id: string;
  submittedAt: string;
  buildingName: string;
  address: string;
  zip: string;
  neighborhood: string;
  unitLabel: string;
  beds: number;
  baths: number;
  monthlyRent: number;
  petFriendly: boolean;
  tagline: string;
  /** Supabase auth user id of the manager who submitted (required for new submissions). */
  submittedByUserId?: string;
  /** Full submission used to generate listing detail page */
  submission?: ManagerListingSubmissionV1;
};

export type ManagerPropertyDraftInput = ManagerListingSubmissionV1;

type PendingMap = Record<string, ManagerPendingPropertyRow[]>;
type ExtrasMap = Record<string, MockProperty[]>;

function isBrowser() {
  return typeof window !== "undefined";
}

function sessionCacheKey(key: string) {
  return `${SESSION_CACHE_PREFIX}${key}`;
}

function readSessionJson<T>(key: string): T | undefined {
  if (!isBrowser()) return undefined;
  try {
    const raw = window.sessionStorage.getItem(sessionCacheKey(key));
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function writeSessionJson(key: string, value: unknown) {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(sessionCacheKey(key), JSON.stringify(value));
  } catch {
    /* ignore session cache write failures */
  }
}

function readPropertyPipelineSyncedAt(): number {
  if (!isBrowser()) return 0;
  try {
    const raw = window.sessionStorage.getItem(PROPERTY_PIPELINE_SYNC_META_KEY);
    const parsed = Number(raw ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function writePropertyPipelineSyncedAt(value: number) {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(PROPERTY_PIPELINE_SYNC_META_KEY, String(value));
  } catch {
    /* ignore session cache write failures */
  }
}

function readJson<T>(key: string, fallback: T): T {
  if (!isBrowser()) return fallback;
  if (memoryStore.has(key)) return memoryStore.get(key) as T;
  const cached = readSessionJson<T>(key);
  if (cached !== undefined) {
    memoryStore.set(key, cached);
    return cached;
  }
  return fallback;
}

function writeJson(key: string, value: unknown, opts?: { silent?: boolean }) {
  if (!isBrowser()) return;
  memoryStore.set(key, value);
  writeSessionJson(key, value);
  if (!opts?.silent) {
    window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
  }
}

function readPendingMap(): PendingMap {
  return parseRecordOfArrays<ManagerPendingPropertyRow>(readJson(PENDING_BY_USER_KEY, {}));
}

function writePendingMap(m: PendingMap) {
  writeJson(PENDING_BY_USER_KEY, m);
}

function readExtrasMap(): ExtrasMap {
  return parseRecordOfArrays<MockProperty>(readJson(EXTRAS_BY_USER_KEY, {}));
}

function writeExtrasMap(m: ExtrasMap, opts?: { silent?: boolean }) {
  writeJson(EXTRAS_BY_USER_KEY, m, opts);
}

/** Demo seed: register live listings for a manager (local-only, no server mirror). */
export function seedDemoManagerProperties(userId: string, extras: MockProperty[]): void {
  if (!isBrowser()) return;
  const map = readExtrasMap();
  map[userId] = extras;
  writeExtrasMap(map);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
  }
}

/**
 * `publicProjection` describes a browser-cache row, not the listing — it must
 * never be written into `property_data`. Stripped at the one boundary every
 * write crosses rather than at each of the dozen call sites that build a
 * `MockProperty` by spreading a cached one.
 */
function propertyDataForServer(propertyData: unknown): unknown {
  if (!propertyData || typeof propertyData !== "object" || Array.isArray(propertyData)) return propertyData ?? null;
  const { publicProjection: _local, ...rest } = propertyData as MockProperty;
  void _local;
  return rest;
}

function mirrorPropertyRecord(input: {
  id: string;
  managerUserId: string | null;
  status: ManagerPropertyRecordStatus;
  rowData?: unknown;
  propertyData?: unknown;
  editRequestNote?: string | null;
}) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/property-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "upsert",
      id: input.id,
      managerUserId: input.managerUserId,
      status: input.status,
      rowData: input.rowData ?? null,
      propertyData: propertyDataForServer(input.propertyData),
      editRequestNote: input.editRequestNote ?? null,
    }),
  }).catch(() => {});
}

export async function upsertPropertyRecordToServer(input: {
  id: string;
  managerUserId: string | null;
  status: ManagerPropertyRecordStatus;
  rowData?: unknown;
  propertyData?: unknown;
  editRequestNote?: string | null;
  /**
   * Receives the server's own explanation when the write is refused, so a
   * caller can say WHY instead of a generic "Could not submit listing." The
   * plan property-limit 403 is the reason this exists: the refusal names the
   * limit and the plan that lifts it, and that sentence has to survive the trip
   * back to the wizard's toast.
   *
   * `code` is the route's machine tag (`property_limit_reached`). A caller the
   * manager did not initiate — the background mirror — must key on it rather
   * than on the presence of a message, because a 500 carries raw Postgres text
   * that has no business appearing in a toast.
   */
  onError?: (message: string, code?: string) => void;
}): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // /demo is browser-local — there is no real record to mirror, but the local
  // write in the caller (updatePendingManagerPropertyOnServer etc.) is the
  // actual save, so this must report success rather than aborting it.
  if (isDemoModeActive()) return true;
  try {
    const res = await fetch("/api/property-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        action: "upsert",
        id: input.id,
        managerUserId: input.managerUserId,
        status: input.status,
        rowData: input.rowData ?? null,
        propertyData: propertyDataForServer(input.propertyData),
        editRequestNote: input.editRequestNote ?? null,
      }),
    });
    if (!res.ok && input.onError) {
      const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
      const message = typeof body?.error === "string" ? body.error.trim() : "";
      const code = typeof body?.code === "string" ? body.code : undefined;
      if (message) input.onError(message, code);
    }
    return res.ok;
  } catch {
    return false;
  }
}

export function deleteMirroredPropertyRecord(id: string) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/property-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  }).catch(() => {});
}

/** Awaited counterpart of `deleteMirroredPropertyRecord`, for callers that must
 * know the row is gone before re-syncing (e.g. re-keying a draft record).
 *
 * Resolves true when the row IS GONE, which is what every caller actually
 * needs to know — not whether this particular request is the one that removed
 * it. A 404 means the route found nothing to delete, so the goal state already
 * holds: the server refuses a delete of a missing row rather than letting it
 * fall into the create branch and reach the globally scoped housing-cleanup
 * helper (see `POST /api/property-records`). Reporting that as a FAILURE would
 * strand a local drafts row the manager can then never clear
 * (`deleteManagerPropertyDraft` keeps the draft visible on a false). Any other
 * non-ok status — 401, 403, 500 — is a genuine failure and still resolves
 * false. */
export async function deletePropertyRecordFromServer(id: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (isDemoModeActive()) return true;
  try {
    const res = await fetch("/api/property-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "delete", id }),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export function cachePublicExtraListings(listings: MockProperty[], opts?: { silent?: boolean }) {
  if (!isBrowser()) return;
  const map = readExtrasMap();
  for (const listing of listings) {
    const uid = listing.managerUserId?.trim() || LEGACY_MANAGER_SCOPE_USER_ID;
    const list = map[uid] ?? [];
    const idx = list.findIndex((p) => p.id === listing.id);
    const prev = idx === -1 ? null : list[idx];
    // The public payload is an ALLOWLIST (`publicListingProjection`), not the
    // stored blob, and this map is the SAME one the manager portal edits and
    // mirrors back into `property_data`. Replacing an authoritative row with a
    // projection would let one visit to /rent/browse — or a native app launch,
    // which hydrates the public catalog for every role — strip the owner's own
    // listing, and their next House-details save would persist it, destroying
    // lease config, wifi, add-on services and the lease template this branch
    // exists to protect.
    //
    // Only a projection landing on a NON-projection is refused, so a public
    // refresh still replaces a public row and the owner's own sync still
    // replaces anything: public fields update either way, the richer submission
    // is simply never downgraded.
    const keepPrevSubmission =
      listing.publicProjection === true && Boolean(prev?.listingSubmission) && prev?.publicProjection !== true;
    const next: MockProperty = {
      ...listing,
      managerUserId: uid,
      ...(keepPrevSubmission
        ? { listingSubmission: prev!.listingSubmission, publicProjection: false }
        : {}),
    };
    if (idx === -1) list.push(next);
    else list[idx] = next;
    map[uid] = list;
  }
  writeExtrasMap(map, opts);
}

export function hasCachedPropertyPipeline(): boolean {
  return readPropertyPipelineSyncedAt() > 0;
}

/** Drop cached pipeline data when the signed-in portal user changes. */
export function resetPropertyPipelineClientCache(): void {
  if (!isBrowser()) return;
  memoryStore.delete(PENDING_BY_USER_KEY);
  memoryStore.delete(EXTRAS_BY_USER_KEY);
  memoryStore.delete("axis_admin_property_buckets_v1");
  lastPipelineSnapshotSig = null;
  writePropertyPipelineSyncedAt(0);
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(SESSION_CACHE_PREFIX)) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
}

export async function syncPropertyPipelineFromServer(opts?: {
  force?: boolean;
  userId?: string | null;
  linkedPropertyIds?: Iterable<string>;
}): Promise<boolean> {
  if (!isBrowser()) return false;
  if (isDemoModeActive()) return true;
  const force = opts?.force === true;
  const lastSyncedAt = readPropertyPipelineSyncedAt();
  if (!force && propertyPipelineSyncPromise) return propertyPipelineSyncPromise;
  if (!force && lastSyncedAt > 0 && Date.now() - lastSyncedAt < PROPERTY_PIPELINE_SYNC_TTL_MS) {
    return true;
  }
  const viewerKey = opts?.userId?.trim() ?? "";
  // The refresher outlives any one call, so it must scope with every queued
  // caller's linked ids rather than closing over one caller's — otherwise a
  // joined caller's ids would be silently dropped from the union below.
  let pendingIds = pendingPipelineLinkedIds.get(viewerKey);
  if (!pendingIds) {
    pendingIds = new Set<string>();
    pendingPipelineLinkedIds.set(viewerKey, pendingIds);
  }
  for (const id of opts?.linkedPropertyIds ?? []) {
    const trimmed = String(id).trim();
    if (trimmed) pendingIds.add(trimmed);
  }
  let refresher = propertyPipelineRefreshers.get(viewerKey);
  if (!refresher) {
    refresher = createCoalescedRefresher(() => {
      // Drain at run start: ids accumulated from here on belong to the next run.
      const linkedPropertyIds = [...(pendingPipelineLinkedIds.get(viewerKey) ?? [])];
      pendingPipelineLinkedIds.delete(viewerKey);
      return runPropertyPipelineSync({ userId: viewerKey || null, linkedPropertyIds });
    });
    propertyPipelineRefreshers.set(viewerKey, refresher);
  }
  return refresher.run(force);
}

async function runPropertyPipelineSync(opts?: {
  userId?: string | null;
  linkedPropertyIds?: Iterable<string>;
}): Promise<boolean> {
  try {
    propertyPipelineSyncPromise = (async () => {
      const res = await fetch("/api/property-records", { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as {
        snapshot?: PropertyPipelineSnapshot;
        linkedPropertyIds?: string[];
      };
      if (!res.ok || !body.snapshot) return false;
      const viewerUserId = opts?.userId?.trim() ?? "";
      // Prefer server-authoritative linked ids (from account_link_invites) and
      // union with any client-known ids. Scoping with only a stale empty client
      // set previously wiped co-managed owner buckets from local storage.
      const linkedFromServer = Array.isArray(body.linkedPropertyIds)
        ? body.linkedPropertyIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
      const linkedFromClient = [...(opts?.linkedPropertyIds ?? [])]
        .map((id) => String(id).trim())
        .filter(Boolean);
      const linkedPropertyIds = [...new Set([...linkedFromServer, ...linkedFromClient])];
      const snapshot =
        viewerUserId
          ? scopePropertyPipelineSnapshotForViewer(body.snapshot, viewerUserId, linkedPropertyIds)
          : body.snapshot;
      const sig = JSON.stringify(snapshot);
      const changed = sig !== lastPipelineSnapshotSig;
      lastPipelineSnapshotSig = sig;
      memoryStore.set(PENDING_BY_USER_KEY, snapshot.pendingByUser);
      writeSessionJson(PENDING_BY_USER_KEY, snapshot.pendingByUser);
      memoryStore.set(EXTRAS_BY_USER_KEY, snapshot.extrasByUser);
      writeSessionJson(EXTRAS_BY_USER_KEY, snapshot.extrasByUser);
      memoryStore.set("axis_admin_property_buckets_v1", snapshot.sideGlobal);
      writeSessionJson("axis_admin_property_buckets_v1", snapshot.sideGlobal);
      for (const [userId, side] of Object.entries(snapshot.sideByUser)) {
        const key = `axis_mgr_property_side_v1_${userId}`;
        memoryStore.set(key, side);
        writeSessionJson(key, side);
      }
      writePropertyPipelineSyncedAt(Date.now());
      // Legacy pending/review rows auto-publish (admin approval queue removed).
      const promoted = await promoteLegacyPendingListingsToLive();
      // Only notify listeners when the snapshot actually changed — an unconditional
      // dispatch here loops with force-syncing listeners (see lastPipelineSnapshotSig).
      // Tagged as sync-originated: the fresh snapshot is already in the local
      // store above, so listeners must NOT force another server round trip.
      if (changed || promoted > 0) {
        window.dispatchEvent(serverSyncOriginatedEvent(PROPERTY_PIPELINE_EVENT));
      }
      return true;
    })();
    return await propertyPipelineSyncPromise;
  } catch {
    return false;
  } finally {
    propertyPipelineSyncPromise = null;
  }
}

export async function mirrorLocalPropertyPipelineToServer(
  managerUserId?: string | null,
  linkedPropertyIds?: Iterable<string>,
  /**
   * Receives the server's explanation the FIRST time a mirrored write is
   * refused BY THE PLAN. A refused row never persists anywhere but this
   * browser, so dropping the response left the manager looking at a listing
   * that exists nowhere else and no reason why. One message per run, not one
   * per row — and, because only one component may own this call, not one per
   * component either.
   *
   * Deliberately narrow: this is background work the manager never initiated,
   * so every OTHER failure stays silent exactly as it did before. The route
   * answers 500 with raw Postgres text and with the "could not read this
   * account's plan" message, and neither belongs in a toast on page load.
   */
  opts?: { onError?: (message: string) => void },
): Promise<void> {
  if (!isBrowser() || isDemoModeActive()) return;
  const scopeUserId = managerUserId?.trim() ?? "";
  // A co-manager's local store can hold LINKED properties that belong to another
  // owner. Those must NEVER be mirrored back to the server under the co-manager's
  // own id — doing so silently transfers/duplicates ownership (the property then
  // shows in the co-manager's portal as owned, unlinked from the real owner).
  // Callers pass the co-manager's linked-property id set so we skip them here.
  const linked = new Set([...(linkedPropertyIds ?? [])].map((id) => String(id).trim()).filter(Boolean));
  const pendingMap = readPendingMap();
  const extrasMap = readExtrasMap();
  const jobs: {
    id: string;
    managerUserId: string;
    status: ManagerPropertyRecordStatus;
    rowData?: unknown;
    propertyData?: unknown;
  }[] = [];
  for (const [ownerId, rows] of Object.entries(pendingMap)) {
    if (scopeUserId && ownerId !== scopeUserId) continue;
    for (const row of rows) {
      if (linked.has(String(row.id))) continue;
      jobs.push({ id: String(row.id), managerUserId: ownerId, status: "pending", rowData: row });
    }
  }
  for (const [ownerId, rows] of Object.entries(extrasMap)) {
    if (scopeUserId && ownerId !== scopeUserId) continue;
    for (const row of rows) {
      if (linked.has(String(row.id))) continue;
      jobs.push({
        id: String(row.id),
        managerUserId: ownerId,
        status: row.adminPublishLive === true ? "live" : "review",
        propertyData: row,
      });
    }
  }

  // SEQUENTIAL on purpose. Every one of these is a write into a plan listing
  // slot, and the server counts the slots already held before it accepts one.
  // Fired concurrently, N creates each read the count before any of them lands,
  // so a one-listing plan mirrors all N — the cap would be racy on exactly the
  // path most likely to send several creates at once. Rows the server already
  // has never reach the count check, so the ordinary on-load re-mirror of an
  // existing portfolio is unaffected.
  let refusal = "";
  for (const job of jobs) {
    await upsertPropertyRecordToServer({
      ...job,
      onError: (message, code) => {
        if (!refusal && code === MANAGER_PROPERTY_LIMIT_ERROR_CODE) refusal = message;
      },
    });
  }
  if (refusal) opts?.onError?.(refusal);
}

// In-flight guards: collapse concurrent duplicate calls into one request.
// No TTL needed — the routes are CDN-cached (see their Cache-Control).
let publicListingsInFlight: Promise<MockProperty[]> | null = null;
const publicLeadInFlight = new Map<string, Promise<MockProperty | null>>();

export async function loadPublicExtraListingsFromServer(): Promise<MockProperty[]> {
  if (publicListingsInFlight) return publicListingsInFlight;
  publicListingsInFlight = fetchPublicExtraListings();
  try {
    return await publicListingsInFlight;
  } finally {
    publicListingsInFlight = null;
  }
}

async function fetchPublicExtraListings(): Promise<MockProperty[]> {
  try {
    // No cache override: response is CDN-cacheable (see route Cache-Control).
    const res = await fetch("/api/property-records/public");
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("application/json")) {
      return readExtraListingsPublic();
    }
    const body = (await res.json()) as { listings?: MockProperty[] };
    const listings = (body.listings ?? []).map((listing) =>
      listing.adminPublishLive === true ? listing : { ...listing, adminPublishLive: true as const },
    );
    cachePublicExtraListings(listings, { silent: true });
    if (isBrowser()) {
      window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
    }
    return listings;
  } catch {
    return readExtraListingsPublic();
  }
}

/** Hydrates a single active property for manager-shared apply/tour deep links. */
export async function loadPublicPropertyLeadFromServer(propertyId: string): Promise<MockProperty | null> {
  const id = propertyId.trim();
  if (!id || !isBrowser()) return null;
  const inFlight = publicLeadInFlight.get(id);
  if (inFlight) return inFlight;
  const promise = fetchPublicPropertyLead(id);
  publicLeadInFlight.set(id, promise);
  try {
    return await promise;
  } finally {
    publicLeadInFlight.delete(id);
  }
}

async function fetchPublicPropertyLead(id: string): Promise<MockProperty | null> {
  try {
    const res = await fetch(`/api/public/property-lead?propertyId=${encodeURIComponent(id)}`);
    const body = (await res.json()) as { property?: MockProperty };
    if (!res.ok || !body.property) return null;
    cachePublicExtraListings([body.property], { silent: true });
    window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
    return body.property;
  } catch {
    return null;
  }
}

let residentPropertyInFlight: Promise<{
  property: MockProperty;
  serviceRequestOptions: ManagerListingServiceOption[];
  managerUserId: string;
  propertyId: string;
} | null> | null = null;

/**
 * Hydrates the signed-in resident's own property (any publish status) so
 * resident-portal views (e.g. offered service request types) see it even
 * though the resident never calls the manager/admin-scoped `/api/property-records`
 * sync or the live-only public catalog.
 */
export async function loadResidentPropertyFromServer(): Promise<{
  property: MockProperty;
  serviceRequestOptions: ManagerListingServiceOption[];
  managerUserId: string;
  propertyId: string;
} | null> {
  if (!isBrowser()) return null;
  if (residentPropertyInFlight) return residentPropertyInFlight;
  residentPropertyInFlight = (async () => {
    try {
      const res = await fetch("/api/portal/resident-property", { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as {
        property?: MockProperty;
        serviceRequestOptions?: ManagerListingServiceOption[];
        managerUserId?: string;
        propertyId?: string;
      };
      if (!res.ok || !body.property) return null;
      cachePublicExtraListings([body.property], { silent: true });
      window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
      const propertyId =
        String(body.propertyId ?? "").trim() ||
        String(body.property.id ?? "").trim();
      const managerUserId =
        String(body.managerUserId ?? "").trim() ||
        String(body.property.managerUserId ?? "").trim();
      return {
        property: body.property,
        serviceRequestOptions: Array.isArray(body.serviceRequestOptions) ? body.serviceRequestOptions : [],
        managerUserId,
        propertyId,
      };
    } catch {
      return null;
    }
  })();
  try {
    return await residentPropertyInFlight;
  } finally {
    residentPropertyInFlight = null;
  }
}

/**
 * One-time: moves flat legacy arrays into the signed-in user's bucket so other accounts stay isolated.
 */
function migrateLegacyGlobalIntoUser(userId: string) {
  void userId;
}

/** All pending rows (admin queue). Legacy global pending key is no longer merged — only per-account storage. */
export function readAllPendingManagerProperties(): ManagerPendingPropertyRow[] {
  const map = readPendingMap();
  return Object.values(map).flat();
}

/** Pending submissions for one manager account only. */
export function readPendingManagerPropertiesForUser(userId: string | null): ManagerPendingPropertyRow[] {
  if (!userId) return [];
  migrateLegacyGlobalIntoUser(userId);
  return readPendingMap()[userId] ?? [];
}

/**
 * @deprecated Use readPendingManagerPropertiesForUser (manager) or readAllPendingManagerProperties (admin).
 * Returns all pending rows for backward compatibility with admin KPIs.
 */
export function readPendingManagerProperties(): ManagerPendingPropertyRow[] {
  return readAllPendingManagerProperties();
}

/** All extra listings across accounts (admin + public catalog). Legacy global extras key is no longer merged. */
export function readAllExtraListings(): MockProperty[] {
  const map = readExtrasMap();
  return Object.values(map).flat();
}

/** Properties visible on manager-shared apply/tour links — active listings only. */
export function isPropertyActiveForLeads(p: Pick<MockProperty, "adminPublishLive">): boolean {
  return p.adminPublishLive === true;
}

/** @deprecated Alias for isPropertyActiveForLeads — kept for older call sites. */
export function isRentCatalogPublished(p: Pick<MockProperty, "adminPublishLive">): boolean {
  return isPropertyActiveForLeads(p);
}

/** Public Rent with Axis catalog: extras that are approved for live search (demo localStorage). */
export function readExtraListingsPublic(): MockProperty[] {
  const byPropertyKey = new Map<string, MockProperty>();
  for (const property of readAllExtraListings().filter(isRentCatalogPublished)) {
    const key = `${property.buildingName}::${property.address}`.trim().toLowerCase();
    byPropertyKey.set(key, property);
  }
  return [...byPropertyKey.values()];
}

/** Listed properties for one manager (portal). */
export function readScopedExtraListings(userId: string | null): MockProperty[] {
  const scopeUserId = resolveManagerScopeUserId(userId);
  if (!scopeUserId) return [];
  const stored = readExtraListingsForUser(scopeUserId);
  return stored;
}

/** Listed properties for one manager (portal). */
export function readExtraListingsForUser(userId: string | null): MockProperty[] {
  if (!userId) return [];
  migrateLegacyGlobalIntoUser(userId);
  return readExtrasMap()[userId] ?? [];
}

/**
 * @deprecated Use readExtraListingsForUser or readExtraListingsPublic.
 * Previously returned a single global list; now aliases public merge for older call sites.
 */
export function readExtraListings(): MockProperty[] {
  return readExtraListingsPublic();
}

/** Pending + live listings for one manager (property cap). */
export function countManagerManagedPropertiesForUser(userId: string | null): number {
  const scopeUserId = resolveManagerScopeUserId(userId);
  if (!scopeUserId) return 0;
  return readPendingManagerPropertiesForUser(scopeUserId).length + readScopedExtraListings(scopeUserId).length;
}

/** @deprecated Use countManagerManagedPropertiesForUser */
export function countManagerManagedProperties(): number {
  return readAllPendingManagerProperties().length + readAllExtraListings().length;
}

function slugPart(s: string | undefined | null) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function deriveLegacyFields(sub: ManagerListingSubmissionV1): Omit<ManagerPendingPropertyRow, "id" | "submittedAt" | "submission" | "submittedByUserId"> {
  const rooms = sub.rooms.filter((r) => r.name.trim().length > 0);
  const rents = rooms.map((r) => r.monthlyRent).filter((n) => Number.isFinite(n) && n > 0);
  const minRent = rents.length ? Math.min(...rents) : 0;
  const unitLabel =
    rooms.length === 0
      ? "New listing"
      : rooms.length === 1
        ? rooms[0]!.name.trim()
        : `${rooms.length} rooms`;

  return {
    buildingName: sub.buildingName.trim(),
    address: sub.address.trim(),
    zip: sub.zip.trim(),
    neighborhood: listingSubmissionLocationLabel(sub),
    unitLabel,
    beds: Math.max(rooms.length || 1, 1),
    baths: Math.max(sub.bathrooms.filter((b) => b.name.trim()).length || 1, 1),
    monthlyRent: minRent,
    petFriendly: sub.petFriendly,
    tagline: sub.tagline.trim() || sub.houseOverview.trim().slice(0, 120) || "Manager-submitted listing",
  };
}

export function submitManagerPendingProperty(input: ManagerPropertyDraftInput, managerUserId: string): string {
  if (!managerUserId.trim()) {
    throw new Error("submitManagerPendingProperty requires a signed-in manager user id.");
  }
  const legacy = deriveLegacyFields(input);
  const draftId = `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const listingId = `mgr-${slugPart(legacy.buildingName)}-${slugPart(legacy.unitLabel)}-${draftId.slice(-6)}`;
  const row: ManagerPendingPropertyRow = {
    ...legacy,
    id: draftId,
    submittedAt: new Date().toISOString(),
    submission: input,
    submittedByUserId: managerUserId,
  };
  const prop: MockProperty = { ...buildMockPropertyFromDraft(row, listingId), adminPublishLive: true };
  appendExtraListing(prop, managerUserId);
  return listingId;
}

/**
 * The single publish path: mirror a submission to the server as a live listing
 * under `listingId` and add it to the local extras catalog. Both the brand-new
 * wizard submit and the draft publish route through this, so the two can never
 * drift on the row shape they write.
 */
export async function publishManagerListingSubmissionToServer(
  listingId: string,
  input: ManagerPropertyDraftInput,
  managerUserId: string,
  opts?: { onError?: (message: string) => void },
): Promise<boolean> {
  if (!managerUserId.trim() || !listingId.trim()) return false;
  const legacy = deriveLegacyFields(input);
  const row: ManagerPendingPropertyRow = {
    ...legacy,
    id: listingId,
    submittedAt: new Date().toISOString(),
    submission: input,
    submittedByUserId: managerUserId,
  };
  const prop: MockProperty = {
    ...buildMockPropertyFromDraft(row, listingId),
    adminPublishLive: true,
    managerUserId,
  };
  const ok = await upsertPropertyRecordToServer({
    id: listingId,
    managerUserId,
    status: "live",
    propertyData: prop,
    rowData: {
      ...legacy,
      adminRefId: listingId,
      listingId,
      managerUserId,
    },
    onError: opts?.onError,
  });
  // The local catalog is only appended once the SERVER accepted the listing, so
  // a plan-limit refusal cannot leave a listing that exists in this browser and
  // nowhere else.
  if (!ok) return false;
  appendExtraListing(prop, managerUserId);
  return true;
}

export async function submitManagerPendingPropertyToServer(
  input: ManagerPropertyDraftInput,
  managerUserId: string,
  opts?: { onError?: (message: string) => void },
): Promise<string | null> {
  if (!managerUserId.trim()) return null;
  const legacy = deriveLegacyFields(input);
  const draftId = `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const listingId = `mgr-${slugPart(legacy.buildingName)}-${slugPart(legacy.unitLabel)}-${draftId.slice(-6)}`;
  if (!(await publishManagerListingSubmissionToServer(listingId, input, managerUserId, opts))) return null;
  await syncPropertyPipelineFromServer({ force: true });
  return listingId;
}

export function updatePendingManagerProperty(
  pendingId: string,
  input: ManagerPropertyDraftInput,
  managerUserId: string,
): boolean {
  if (!managerUserId.trim()) return false;
  const map = readPendingMap();
  const list = map[managerUserId];
  if (!list) return false;
  const idx = list.findIndex((p) => p.id === pendingId);
  if (idx === -1) return false;
  const legacy = deriveLegacyFields(input);
  list[idx] = {
    ...list[idx]!,
    ...legacy,
    submission: input,
  };
  map[managerUserId] = list;
  writePendingMap(map);
  mirrorPropertyRecord({ id: pendingId, managerUserId, status: "pending", rowData: list[idx] });
  if (typeof window !== "undefined") {
    window.dispatchEvent(serverSyncOriginatedEvent(PROPERTY_PIPELINE_EVENT));
  }
  return true;
}

export async function updatePendingManagerPropertyOnServer(
  pendingId: string,
  input: ManagerPropertyDraftInput,
  managerUserId: string,
): Promise<boolean> {
  if (!managerUserId.trim()) return false;
  const map = readPendingMap();
  const list = map[managerUserId] ?? [];
  const idx = list.findIndex((p) => p.id === pendingId);
  const legacy = deriveLegacyFields(input);
  const row: ManagerPendingPropertyRow = {
    ...(idx === -1 ? { id: pendingId, submittedAt: new Date().toISOString(), submittedByUserId: managerUserId } : list[idx]!),
    ...legacy,
    submission: input,
  };
  const ok = await upsertPropertyRecordToServer({ id: pendingId, managerUserId, status: "pending", rowData: row });
  if (!ok) return false;
  const nextList = [...list];
  if (idx === -1) nextList.push(row);
  else nextList[idx] = row;
  map[managerUserId] = nextList;
  writePendingMap(map);
  await syncPropertyPipelineFromServer({ force: true });
  return true;
}

export function updateExtraListingFromSubmission(
  listingId: string,
  managerUserId: string,
  input: ManagerPropertyDraftInput,
): boolean {
  if (!managerUserId.trim()) return false;
  const map = readExtrasMap();
  // This path only ever EDITS a listing that is ALREADY live. Resolve it across
  // the whole catalog, because a co-managed listing lives under its owner's key,
  // not the editing manager's. An id that is nowhere in the catalog is not a live
  // listing (a draft, an unlisted row) — writing it here would mirror that record
  // as `status: "live"` and publish it to the public rent catalog unvalidated.
  const ownerKey = Object.keys(map).find((uid) => (map[uid] ?? []).some((p) => p.id === listingId));
  if (!ownerKey) return false;
  const list = map[ownerKey]!;
  const idx = list.findIndex((p) => p.id === listingId);
  const legacy = deriveLegacyFields(input);
  const pendingLike: ManagerPendingPropertyRow = {
    ...legacy,
    id: listingId,
    submittedAt: new Date().toISOString(),
    submission: input,
    submittedByUserId: managerUserId,
  };
  const next = buildMockPropertyFromDraft(pendingLike, listingId);
  // An edit never transfers ownership — a co-manager saving a linked listing
  // must leave it owned by the manager whose catalog it lives in.
  const owner = list[idx]!.managerUserId ?? next.managerUserId ?? ownerKey;
  // Listings publish immediately — edits stay live on the rent catalog.
  const publishLive = true;
  list[idx] = { ...next, managerUserId: owner, adminPublishLive: publishLive };
  map[ownerKey] = list;
  writeExtrasMap(map);
  if (typeof window !== "undefined") {
    // Local write only — tag sync-originated so listeners re-read storage without
    // racing the in-flight server mirror with a stale server snapshot.
    window.dispatchEvent(serverSyncOriginatedEvent(PROPERTY_PIPELINE_EVENT));
  }
  mirrorPropertyRecord({
    id: listingId,
    managerUserId,
    status: "live",
    propertyData: list[idx],
    rowData: { ...legacy, adminRefId: listingId, listingId, managerUserId },
  });
  return true;
}

export async function updateExtraListingFromSubmissionOnServer(
  listingId: string,
  managerUserId: string,
  input: ManagerPropertyDraftInput,
): Promise<boolean> {
  if (!managerUserId.trim()) return false;
  const map = readExtrasMap();
  const ownerKey = Object.keys(map).find((uid) => (map[uid] ?? []).some((p) => p.id === listingId));
  const legacy = deriveLegacyFields(input);
  const pendingLike: ManagerPendingPropertyRow = {
    ...legacy,
    id: listingId,
    submittedAt: new Date().toISOString(),
    submission: input,
    submittedByUserId: managerUserId,
  };
  const next = buildMockPropertyFromDraft(pendingLike, listingId);
  if (!ownerKey) {
    const propertyData: MockProperty = { ...next, managerUserId, adminPublishLive: true };
    const rowData = { ...legacy, adminRefId: listingId, listingId, managerUserId };
    const ok = await upsertPropertyRecordToServer({
      id: listingId,
      managerUserId,
      status: "live",
      propertyData,
      rowData,
    });
    if (!ok) return false;
    await syncPropertyPipelineFromServer({ force: true });
    return true;
  }
  const list = map[ownerKey]!;
  const idx = list.findIndex((p) => p.id === listingId);
  if (idx === -1) return false;
  const owner = list[idx]!.managerUserId ?? next.managerUserId ?? ownerKey;
  const propertyData: MockProperty = { ...next, managerUserId: owner, adminPublishLive: true };
  const rowData = { ...legacy, adminRefId: listingId, listingId, managerUserId };
  const ok = await upsertPropertyRecordToServer({
    id: listingId,
    managerUserId,
    status: "live",
    propertyData,
    rowData,
  });
  if (!ok) return false;
  list[idx] = propertyData;
  map[ownerKey] = list;
  writeExtrasMap(map);
  if (typeof window !== "undefined") {
    window.dispatchEvent(serverSyncOriginatedEvent(PROPERTY_PIPELINE_EVENT));
  }
  await syncPropertyPipelineFromServer({ force: true });
  return true;
}

/** Sets a manager `mgr-*` listing live on the rent catalog again after admin review. */
export function republishManagerListingAfterReview(listingId: string): boolean {
  if (!listingId.startsWith("mgr-")) return false;
  const map = readExtrasMap();
  for (const uid of Object.keys(map)) {
    const list = map[uid]!;
    const idx = list.findIndex((p) => p.id === listingId);
    if (idx === -1) continue;
    const cur = list[idx]!;
    list[idx] = { ...cur, adminPublishLive: true };
    map[uid] = list;
    writeExtrasMap(map);
    mirrorPropertyRecord({ id: listingId, managerUserId: uid, status: "live", propertyData: list[idx] });
    return true;
  }
  return false;
}

/** Publish from an admin-bucket row (no stored submission — listing uses defaults until edited). */
export function buildMockPropertyFromAdminRow(row: ManagerAdminShapeRow, listingId: string): MockProperty {
  const pendingLike: ManagerPendingPropertyRow = {
    id: row.adminRefId,
    submittedAt: new Date().toISOString(),
    buildingName: row.buildingName,
    address: row.address,
    zip: row.zip,
    neighborhood: row.neighborhood,
    unitLabel: row.unitLabel,
    beds: row.beds,
    baths: row.baths,
    monthlyRent: row.monthlyRent,
    petFriendly: row.petFriendly,
    tagline: row.tagline,
    submission: undefined,
    submittedByUserId: LEGACY_MANAGER_SCOPE_USER_ID,
  };
  return buildMockPropertyFromDraft(pendingLike, listingId);
}

export function buildMockPropertyFromDraft(row: ManagerPendingPropertyRow, listingId: string): MockProperty {
  const str = (v: unknown) => String(v ?? "").trim();
  const num = (v: unknown, fallback = 0) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const buildingName = str(row.buildingName);
  const unitLabel = str(row.unitLabel);
  const title = `${buildingName || "Property"} · ${unitLabel || "Unit"}`;
  const owner = row.submittedByUserId ?? LEGACY_MANAGER_SCOPE_USER_ID;
  const monthlyRent = num(row.monthlyRent, 0);
  const beds = Math.max(0, Math.floor(num(row.beds, 1)));
  const baths = Math.max(0, num(row.baths, 1));
  return {
    id: listingId,
    title,
    tagline: str(row.tagline) || "Manager-submitted listing",
    address: str(row.address),
    zip: str(row.zip),
    neighborhood: str(row.neighborhood),
    beds,
    baths,
    rentLabel: `$${monthlyRent}`,
    available: "Now",
    petFriendly: Boolean(row.petFriendly),
    buildingId: `mgr-bld-${slugPart(buildingName)}`,
    buildingName,
    unitLabel,
    mapLat: 47.61405,
    mapLng: -122.31542,
    listingSubmission: row.submission,
    managerUserId: owner,
  };
}

export function appendExtraListing(prop: MockProperty, ownerUserId: string) {
  const uid = ownerUserId.trim() || prop.managerUserId || LEGACY_MANAGER_SCOPE_USER_ID;
  const map = readExtrasMap();
  const list = map[uid] ?? [];
  list.push({ ...prop, managerUserId: uid });
  map[uid] = list;
  writeExtrasMap(map);
  mirrorPropertyRecord({ id: prop.id, managerUserId: uid, status: prop.adminPublishLive === true ? "live" : "review", propertyData: { ...prop, managerUserId: uid } });
}

/** Deletes a pending submission from the signed-in manager’s queue only (does not approve or publish). */
export function deletePendingSubmissionForManager(pendingId: string, managerUserId: string | null): boolean {
  if (!managerUserId?.trim()) return false;
  const uid = managerUserId.trim();
  migrateLegacyGlobalIntoUser(uid);
  const map = readPendingMap();
  const list = map[uid] ?? [];
  const idx = list.findIndex((p) => p.id === pendingId);
  if (idx === -1) return false;
  map[uid] = [...list.slice(0, idx), ...list.slice(idx + 1)];
  writePendingMap(map);
  deleteMirroredPropertyRecord(pendingId);
  window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
  return true;
}

/** Removes a pending row from whichever account owns it. */
export function takePendingManagerProperty(pendingId: string): ManagerPendingPropertyRow | null {
  const map = readPendingMap();
  for (const uid of Object.keys(map)) {
    const rows = map[uid]!;
    const idx = rows.findIndex((p) => p.id === pendingId);
    if (idx !== -1) {
      const row = rows[idx]!;
      map[uid] = [...rows.slice(0, idx), ...rows.slice(idx + 1)];
      writePendingMap(map);
      deleteMirroredPropertyRecord(pendingId);
      return row;
    }
  }
  return null;
}

/** Removes a live listing from whichever account owns it. */
export function removeExtraListing(listingId: string): MockProperty | null {
  const map = readExtrasMap();
  for (const uid of Object.keys(map)) {
    const rows = map[uid]!;
    const idx = rows.findIndex((p) => p.id === listingId);
    if (idx !== -1) {
      const row = rows[idx]!;
      map[uid] = [...rows.slice(0, idx), ...rows.slice(idx + 1)];
      writeExtrasMap(map);
      deleteMirroredPropertyRecord(listingId);
      return row;
    }
  }
  return null;
}

/** Promotes a manager submission to a public listing (per-owner storage). */
export function approvePendingManagerProperty(pendingId: string): MockProperty | null {
  const row = takePendingManagerProperty(pendingId);
  if (!row) return null;

  const listingId = `mgr-${slugPart(row.buildingName)}-${slugPart(row.unitLabel)}-${pendingId.slice(-6)}`;
  const prop: MockProperty = { ...buildMockPropertyFromDraft(row, listingId), adminPublishLive: true };
  const owner = row.submittedByUserId ?? LEGACY_MANAGER_SCOPE_USER_ID;
  migrateAmenityOffersPropertyId(owner, pendingId, listingId);
  appendExtraListing(prop, owner);
  return prop;
}

/** Promotes legacy pending/review submissions to live (listings no longer need admin approval). */
export async function promoteLegacyPendingListingsToLive(): Promise<number> {
  if (!isBrowser()) return 0;
  let promoted = 0;

  const extrasMap = readExtrasMap();
  let extrasDirty = false;
  for (const uid of Object.keys(extrasMap)) {
    const list = extrasMap[uid] ?? [];
    let changed = false;
    const next = list.map((p) => {
      if (p.adminPublishLive === true) return p;
      changed = true;
      promoted += 1;
      const live = { ...p, adminPublishLive: true as const };
      mirrorPropertyRecord({
        id: p.id,
        managerUserId: uid,
        status: "live",
        propertyData: live,
      });
      void upsertPropertyRecordToServer({
        id: p.id,
        managerUserId: uid,
        status: "live",
        propertyData: live,
      });
      return live;
    });
    if (changed) {
      extrasMap[uid] = next;
      extrasDirty = true;
    }
  }
  if (extrasDirty) writeExtrasMap(extrasMap);

  for (const pending of [...readAllPendingManagerProperties()]) {
    const created = approvePendingManagerProperty(pending.id);
    if (!created) continue;
    promoted += 1;
    const owner = created.managerUserId ?? pending.submittedByUserId ?? "";
    if (owner) {
      void upsertPropertyRecordToServer({
        id: created.id,
        managerUserId: owner,
        status: "live",
        propertyData: created,
        rowData: {
          adminRefId: created.id,
          listingId: created.id,
          managerUserId: owner,
          buildingName: created.buildingName,
          unitLabel: created.unitLabel,
          address: created.address,
        },
      });
      void fetch("/api/property-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: pending.id }),
      }).catch(() => {});
    }
  }

  return promoted;
}

/** Reserved for optional onboarding seeding; no automatic listing data is injected. */
export function ensureDemoManagerPipelineSeed(): void {
  /* no-op */
}
