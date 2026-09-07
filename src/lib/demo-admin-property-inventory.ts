import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import type { MockProperty } from "@/data/types";
import {
  appendExtraListing,
  buildMockPropertyFromAdminRow,
  buildMockPropertyFromDraft,
  deleteMirroredPropertyRecord,
  deletePropertyRecordFromServer,
  deriveLegacyFields,
  LEGACY_MANAGER_SCOPE_USER_ID,
  PROPERTY_PIPELINE_EVENT,
  readAllExtraListings,
  readAllPendingManagerProperties,
  readExtraListingsForUser,
  readScopedExtraListings,
  removeExtraListing,
  publishManagerListingSubmissionToServer,
  submitManagerPendingProperty,
  syncPropertyPipelineFromServer,
  takePendingManagerProperty,
  upsertPropertyRecordToServer,
  type ManagerPendingPropertyRow,
  type ManagerPropertyDraftInput,
} from "@/lib/demo-property-pipeline";
import { deleteSubmissionMediaObjects } from "@/lib/listing-media-storage";
import { migrateAmenityOffersPropertyId } from "@/lib/manager-amenity-catalog-storage";
import { legacyAdminFieldsToSubmission, normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { collectLinkedPropertyIdsForModule, readLinkedListingsForUser, safePropertyOptionLabel } from "@/lib/manager-portfolio-access";
import type { ManagerPropertyRecordStatus } from "@/lib/persisted-property-records";
import { parseMonthlyRent } from "@/lib/listings-search";
import { monthlyRentListingLabel } from "@/lib/rental-application/listing-fees-display";

/** Admin-wide queue (all managers). Manager portal passes `forManagerUserId` for isolated side-buckets. */
const SIDE_KEY_GLOBAL = "axis_admin_property_buckets_v1";
const sideMemory = new Map<string, unknown>();
/** Must match the session-cache prefix in demo-property-pipeline.ts — that's where
 *  syncPropertyPipelineFromServer persists the synced side buckets, so a fresh page
 *  load (e.g. a different portal session) can rehydrate them here. */
const SESSION_CACHE_PREFIX = "axis_property_pipeline_cache_v1:";

function sideKey(forManagerUserId?: string | null): string {
  if (forManagerUserId) return `axis_mgr_property_side_v1_${forManagerUserId}`;
  return SIDE_KEY_GLOBAL;
}

/** Admin-only moves (reject / decline). Managers must not invoke these from the portal UI. */
function adminListingRejectAllowed(): boolean {
  if (typeof window === "undefined") return true;
  return window.location.pathname.startsWith("/admin");
}

// 0 pending · 1 request_change · 2 live · 3 unlisted · 4 rejected · 5 draft.
export type AdminPropertyBucketIndex = 0 | 1 | 2 | 3 | 4 | 5;

export type AdminPropertyRow = {
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
  /** Formatted rent for display, e.g. "$1,100.00/mo" or "$1,100.00–$1,250.00/mo" when room rents differ. Falls back to `monthlyRent` when absent. */
  rentRangeLabel?: string;
  listingId?: string;
  /** Owning manager (Supabase user id) for scoped demo data. */
  managerUserId?: string;
  /** Last admin “request edit” message shown to the submitting manager/owner (demo localStorage). */
  editRequestNote?: string;
  /** Full submission preserved so images and rich content survive the admin approval flow. */
  submission?: ManagerListingSubmissionV1;
  /** Wizard step a draft was saved on, so resuming reopens where the manager left off. */
  draftStepIndex?: number;
  /** Furthest wizard step a draft reached, so the step chips stay unlocked on resume. */
  draftMaxStepReached?: number;
  /** True while a draft's id was minted before it had a property name (see `saveManagerPropertyDraftToServer`). */
  draftIdProvisional?: boolean;
};

type SideBuckets = {
  requestChange: AdminPropertyRow[];
  unlisted: AdminPropertyRow[];
  rejected: AdminPropertyRow[];
  /** In-progress "add property" wizards the manager saved to finish later. */
  drafts: AdminPropertyRow[];
};

function isBrowser() {
  return typeof window !== "undefined";
}

function readJson<T>(key: string, fallback: T): T {
  if (!isBrowser()) return fallback;
  if (sideMemory.has(key)) return sideMemory.get(key) as T;
  try {
    const raw = window.sessionStorage.getItem(`${SESSION_CACHE_PREFIX}${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as T;
      sideMemory.set(key, parsed);
      return parsed;
    }
  } catch {
    /* ignore session cache read failures */
  }
  return fallback;
}

function writeSideStorage(side: SideBuckets, forManagerUserId?: string | null) {
  if (!isBrowser()) return;
  const key = sideKey(forManagerUserId);
  sideMemory.set(key, side);
  try {
    window.sessionStorage.setItem(`${SESSION_CACHE_PREFIX}${key}`, JSON.stringify(side));
  } catch {
    /* ignore session cache write failures */
  }
  window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
}

function mirrorAdminPropertyRecord(input: {
  id: string;
  managerUserId?: string | null;
  status: ManagerPropertyRecordStatus;
  rowData: AdminPropertyRow;
  propertyData?: MockProperty | null;
  editRequestNote?: string | null;
}) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/property-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "upsert",
      id: input.id,
      managerUserId: input.managerUserId ?? input.rowData.managerUserId ?? null,
      status: input.status,
      rowData: input.rowData,
      propertyData: input.propertyData ?? null,
      editRequestNote: input.editRequestNote ?? input.rowData.editRequestNote ?? null,
    }),
  }).catch(() => {});
}

function readSide(forManagerUserId?: string | null): SideBuckets {
  const raw = readJson<Partial<SideBuckets> | null>(sideKey(forManagerUserId), null);
  if (!raw || typeof raw !== "object") {
    return { requestChange: [], unlisted: [], rejected: [], drafts: [] };
  }
  return {
    requestChange: Array.isArray(raw.requestChange) ? raw.requestChange : [],
    unlisted: Array.isArray(raw.unlisted) ? raw.unlisted : [],
    rejected: Array.isArray(raw.rejected) ? raw.rejected : [],
    drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
  };
}

function slugPart(s: string | undefined | null) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function newAdminRefId() {
  return `adm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Coerce partial / legacy localStorage rows so UI never calls `.trim()` on undefined. */
export function normalizeAdminPropertyRow(row: Partial<AdminPropertyRow> & { adminRefId?: string }): AdminPropertyRow {
  const str = (v: unknown) => String(v ?? "").trim();
  const n = (v: unknown, fallback = 0) => {
    const x = typeof v === "number" ? v : Number(v);
    return Number.isFinite(x) ? x : fallback;
  };
  const id = str(row.adminRefId);
  const buildingName = str(row.buildingName) || str(row.submission?.buildingName);
  return {
    adminRefId: id || `adm-${Date.now()}`,
    buildingName,
    unitLabel: str(row.unitLabel),
    address: str(row.address),
    zip: str(row.zip),
    neighborhood: str(row.neighborhood),
    beds: Math.max(0, Math.floor(n(row.beds, 1))),
    baths: Math.max(0, n(row.baths, 1)),
    monthlyRent: Math.max(0, n(row.monthlyRent, 0)),
    petFriendly: Boolean(row.petFriendly),
    tagline: str(row.tagline),
    rentRangeLabel: row.rentRangeLabel || undefined,
    listingId: row.listingId,
    managerUserId: row.managerUserId,
    editRequestNote: row.editRequestNote,
    submission: row.submission,
    draftStepIndex: row.draftStepIndex == null ? undefined : Math.max(0, Math.floor(n(row.draftStepIndex, 0))),
    draftMaxStepReached:
      row.draftMaxStepReached == null ? undefined : Math.max(0, Math.floor(n(row.draftMaxStepReached, 0))),
    draftIdProvisional: row.draftIdProvisional === true ? true : undefined,
  };
}

export function pendingToAdminRow(row: ManagerPendingPropertyRow): AdminPropertyRow {
  return {
    ...normalizeAdminPropertyRow({
      adminRefId: row.id,
      buildingName: row.buildingName,
      unitLabel: row.unitLabel,
      address: row.address,
      zip: row.zip,
      neighborhood: row.neighborhood,
      beds: row.beds,
      baths: row.baths,
      monthlyRent: row.monthlyRent,
      petFriendly: row.petFriendly,
      tagline: row.tagline ?? "",
      managerUserId: row.submittedByUserId,
      rentRangeLabel: row.submission?.v ? monthlyRentListingLabel(row.submission) : undefined,
    }),
    submission: row.submission,
  };
}

/** Preview mock for portal “More details” — same shape as public listing page. */
export function resolveAdminPropertyRowPreview(row: AdminPropertyRow): MockProperty {
  const pending = readAllPendingManagerProperties().find((p) => p.id === row.adminRefId);
  if (pending) {
    return buildMockPropertyFromDraft(pending, row.listingId ?? `preview-${pending.id}`);
  }
  if (row.listingId) {
    const hit = readAllExtraListings().find((p) => p.id === row.listingId);
    if (hit) return hit;
  }
  return buildMockPropertyFromAdminRow(row, row.listingId ?? `preview-${row.adminRefId}`);
}

/** Public listing URL when the row is live on Rent with Axis (not a draft preview id). */
export function publicListingHrefForPropertyRow(row: AdminPropertyRow): string | null {
  const id = row.listingId;
  if (!id || id.startsWith("preview-") || id.startsWith("demo-")) return null;
  return `/rent/listings/${id}`;
}

export function mockToAdminRow(prop: MockProperty, listingId: string): AdminPropertyRow {
  const rentNum = parseMonthlyRent(prop.rentLabel ?? "") ?? 0;
  return normalizeAdminPropertyRow({
    adminRefId: listingId,
    buildingName:
      prop.buildingName?.trim() ||
      prop.listingSubmission?.buildingName?.trim() ||
      prop.title?.trim() ||
      "",
    unitLabel: prop.unitLabel,
    address: prop.address,
    zip: prop.zip,
    neighborhood: prop.neighborhood,
    beds: prop.beds,
    baths: prop.baths,
    monthlyRent: rentNum,
    petFriendly: prop.petFriendly,
    tagline: prop.tagline ?? "",
    rentRangeLabel: prop.listingSubmission?.v ? monthlyRentListingLabel(prop.listingSubmission) : undefined,
    listingId,
    managerUserId: prop.managerUserId,
    submission: prop.listingSubmission,
  });
}

/** Rent to show on property cards: the formatted range label when rooms have distinct rents, else a plain single price. */
export function adminPropertyRentDisplayLabel(row: AdminPropertyRow): string {
  return row.rentRangeLabel || `$${row.monthlyRent}/mo`;
}

/** Stable display label for sorting manager property tables (matches picker labels). */
export function adminPropertyRowDisplayLabel(row: AdminPropertyRow): string {
  const id = (row.listingId ?? row.adminRefId).trim() || row.adminRefId;
  return safePropertyOptionLabel(
    [row.buildingName, row.unitLabel, row.submission?.buildingName, row.address],
    id,
  );
}

/** Deterministic manager-portal property order (name, then address, then id). */
export function compareAdminPropertyRowsForDisplay(a: AdminPropertyRow, b: AdminPropertyRow): number {
  const byLabel = adminPropertyRowDisplayLabel(a).localeCompare(adminPropertyRowDisplayLabel(b), undefined, {
    sensitivity: "base",
    numeric: true,
  });
  if (byLabel !== 0) return byLabel;
  const byAddress = a.address.localeCompare(b.address, undefined, { sensitivity: "base", numeric: true });
  if (byAddress !== 0) return byAddress;
  const idA = (a.listingId ?? a.adminRefId).trim();
  const idB = (b.listingId ?? b.adminRefId).trim();
  return idA.localeCompare(idB);
}

export function sortAdminPropertyRowsForDisplay(rows: AdminPropertyRow[]): AdminPropertyRow[] {
  return [...rows].sort(compareAdminPropertyRowsForDisplay);
}

function dedupeAdminPropertyRows(rows: AdminPropertyRow[]): AdminPropertyRow[] {
  const seen = new Set<string>();
  const out: AdminPropertyRow[] = [];
  for (const row of rows) {
    const key = (row.listingId ?? row.adminRefId).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return sortAdminPropertyRowsForDisplay(out);
}

function linkedAdminPropertyRowsForBucket(bucket: AdminPropertyBucketIndex, userId: string): AdminPropertyRow[] {
  // Gate the Properties tab by the `properties` module grant (empty perms = full
  // access, per modulePermsAllow). Previously this used the module-agnostic
  // collectLinkedPropertyIds, so a co-manager granted only e.g. `payments` on a
  // property still saw it in the Properties tab. Buckets 0/2 additionally were
  // not filtering the readLinkedListingsForUser results by the id set at all.
  const linkedIds = collectLinkedPropertyIdsForModule(userId, "properties");
  if (linkedIds.size === 0) return [];

  if (bucket === 0) {
    const rows: AdminPropertyRow[] = [];
    for (const pending of readAllPendingManagerProperties()) {
      if (linkedIds.has(pending.id)) rows.push(pendingToAdminRow(pending));
    }
    for (const { listing } of readLinkedListingsForUser(userId)) {
      if (linkedIds.has(listing.id) && listing.id.startsWith("mgr-") && listing.adminPublishLive !== true) {
        rows.push(mockToAdminRow(listing, listing.id));
      }
    }
    return rows;
  }

  if (bucket === 2) {
    return readLinkedListingsForUser(userId)
      .filter(
        ({ listing }) =>
          linkedIds.has(listing.id) && listing.id.startsWith("mgr-") && listing.adminPublishLive === true,
      )
      .map(({ listing }) => mockToAdminRow(listing, listing.id));
  }

  const matchesLinked = (row: AdminPropertyRow) =>
    linkedIds.has(row.adminRefId) || (row.listingId != null && linkedIds.has(row.listingId));

  const rows: AdminPropertyRow[] = [];
  for (const { listing, ownerUserId } of readLinkedListingsForUser(userId)) {
    if (!linkedIds.has(listing.id)) continue;
    const side = readSide(ownerUserId);
    if (bucket === 1) rows.push(...side.requestChange.filter(matchesLinked));
    if (bucket === 3) rows.push(...side.unlisted.filter(matchesLinked));
    if (bucket === 4) rows.push(...side.rejected.filter(matchesLinked));
  }
  return rows.map((row) => normalizeAdminPropertyRow(row));
}

/**
 * When `forManagerUserId` is set, counts only that manager’s pipeline + side
 * buckets (property portal). Tuple indices mirror AdminPropertyBucketIndex:
 * [pending, request_change, live, unlisted, rejected, draft].
 */
export function adminKpiCounts(
  forManagerUserId?: string | null,
): [number, number, number, number, number, number] {
  try {
    const scopeUserId = resolveManagerScopeUserId(forManagerUserId ?? null);
    if (scopeUserId) {
      const extras = readScopedExtraListings(scopeUserId);
      const side = readSide(scopeUserId);
      const listed = extras.filter((p) => p?.adminPublishLive === true).length;
      return [
        0,
        0,
        listed + linkedAdminPropertyRowsForBucket(2, scopeUserId).length,
        side.unlisted.length + linkedAdminPropertyRowsForBucket(3, scopeUserId).length,
        0,
        side.drafts.length,
      ];
    }
    const side = readSide();
    const listed = readAllExtraListings().filter((p) => p?.adminPublishLive === true).length;
    return [0, 0, listed, side.unlisted.length, 0, side.drafts.length];
  } catch {
    return [0, 0, 0, 0, 0, 0];
  }
}

export function readAdminPropertyRows(
  bucket: AdminPropertyBucketIndex,
  forManagerUserId?: string | null,
): AdminPropertyRow[] {
  const side = readSide(forManagerUserId);
  if (bucket === 0 || bucket === 1 || bucket === 4) {
    // Approval queue removed — listings publish immediately.
    return [];
  }
  if (bucket === 2) {
    const extras = forManagerUserId ? readScopedExtraListings(forManagerUserId) : readAllExtraListings();
    const live = extras.filter((p) => p.adminPublishLive === true);
    const linked = forManagerUserId ? linkedAdminPropertyRowsForBucket(2, forManagerUserId) : [];
    return dedupeAdminPropertyRows([...live.map((p) => mockToAdminRow(p, p.id)), ...linked]);
  }
  if (bucket === 3) {
    return dedupeAdminPropertyRows([
      ...side.unlisted.map((r) => normalizeAdminPropertyRow(r)),
      ...(forManagerUserId ? linkedAdminPropertyRowsForBucket(3, forManagerUserId) : []),
    ]);
  }
  if (bucket === 5) {
    // Drafts are private to their owner — never surfaced to co-managers, so no
    // linked-bucket merge here.
    return dedupeAdminPropertyRows(side.drafts.map((r) => normalizeAdminPropertyRow(r)));
  }
  return [];
}

/** Deduped property rows for a manager portal stage tab (matches visible table rows). */
export function managerPropertyRowsForStage(
  stageBuckets: AdminPropertyBucketIndex[],
  forManagerUserId: string | null,
): AdminPropertyRow[] {
  if (!forManagerUserId) return [];
  return dedupeAdminPropertyRows(stageBuckets.flatMap((bucket) => readAdminPropertyRows(bucket, forManagerUserId)));
}

export function movePendingToRequestChange(
  pendingId: string,
  forManagerUserId?: string | null,
  editRequestNote?: string,
): boolean {
  const row = takePendingManagerProperty(pendingId);
  if (!row) return false;
  const side = readSide(forManagerUserId);
  const note = editRequestNote?.trim();
  side.requestChange.push({
    ...pendingToAdminRow(row),
    ...(note ? { editRequestNote: note } : {}),
  });
  writeSideStorage(side, forManagerUserId);
  const next = side.requestChange[side.requestChange.length - 1]!;
  mirrorAdminPropertyRecord({
    id: next.adminRefId,
    managerUserId: next.managerUserId ?? forManagerUserId,
    status: "request_change",
    rowData: next,
    editRequestNote: note,
  });
  return true;
}

export function movePendingToRejected(pendingId: string, forManagerUserId?: string | null): boolean {
  if (!adminListingRejectAllowed()) return false;
  const row = takePendingManagerProperty(pendingId);
  if (!row) return false;
  const side = readSide(forManagerUserId);
  side.rejected.push({ ...pendingToAdminRow(row), adminRefId: newAdminRefId() });
  writeSideStorage(side, forManagerUserId);
  const next = side.rejected[side.rejected.length - 1]!;
  mirrorAdminPropertyRecord({ id: next.adminRefId, managerUserId: next.managerUserId ?? forManagerUserId, status: "rejected", rowData: next });
  return true;
}

export function approveFromRequestChange(adminRefId: string, forManagerUserId?: string | null): boolean {
  const side = readSide(forManagerUserId);
  const idx = side.requestChange.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const row = side.requestChange[idx]!;
  const nextRc = [...side.requestChange.slice(0, idx), ...side.requestChange.slice(idx + 1)];
  const listingId = `mgr-${slugPart(row.buildingName)}-${slugPart(row.unitLabel)}-${adminRefId.slice(-6)}`;
  const prop = row.submission
    ? buildMockPropertyFromDraft({ ...row, id: listingId, submittedAt: new Date().toISOString(), submission: row.submission, submittedByUserId: row.managerUserId ?? LEGACY_MANAGER_SCOPE_USER_ID }, listingId)
    : buildMockPropertyFromAdminRow(row, listingId);
  const owner = row.managerUserId ?? LEGACY_MANAGER_SCOPE_USER_ID;
  migrateAmenityOffersPropertyId(owner, adminRefId, listingId);
  appendExtraListing({ ...prop, managerUserId: owner, adminPublishLive: true }, owner);
  writeSideStorage({ ...side, requestChange: nextRc }, forManagerUserId);
  deleteMirroredPropertyRecord(adminRefId);
  return true;
}

export function declineFromRequestChange(adminRefId: string, forManagerUserId?: string | null): boolean {
  if (!adminListingRejectAllowed()) return false;
  const side = readSide(forManagerUserId);
  const idx = side.requestChange.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const row = side.requestChange[idx]!;
  const nextRc = [...side.requestChange.slice(0, idx), ...side.requestChange.slice(idx + 1)];
  side.rejected.push({ ...row, adminRefId: newAdminRefId() });
  writeSideStorage({ ...side, requestChange: nextRc }, forManagerUserId);
  deleteMirroredPropertyRecord(adminRefId);
  const next = side.rejected[side.rejected.length - 1]!;
  mirrorAdminPropertyRecord({ id: next.adminRefId, managerUserId: next.managerUserId ?? forManagerUserId, status: "rejected", rowData: next });
  return true;
}

export function returnRequestChangeToPending(adminRefId: string, forManagerUserId?: string | null): boolean {
  const side = readSide(forManagerUserId);
  const idx = side.requestChange.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const row = side.requestChange[idx]!;
  const nextRc = [...side.requestChange.slice(0, idx), ...side.requestChange.slice(idx + 1)];
  const uid = row.managerUserId ?? forManagerUserId ?? LEGACY_MANAGER_SCOPE_USER_ID;
  submitManagerPendingProperty(legacyAdminFieldsToSubmission(row), uid);
  writeSideStorage({ ...side, requestChange: nextRc }, forManagerUserId);
  deleteMirroredPropertyRecord(adminRefId);
  return true;
}

export function updateRequestChangeProperty(
  adminRefId: string,
  forManagerUserId: string | null,
  input: ManagerPropertyDraftInput,
): boolean {
  const side = readSide(forManagerUserId);
  const idx = side.requestChange.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const row = side.requestChange[idx]!;
  const listingId = row.listingId?.trim() || adminRefId;
  const owner = row.managerUserId ?? forManagerUserId ?? LEGACY_MANAGER_SCOPE_USER_ID;

  const prop = buildMockPropertyFromDraft(
    {
      ...row,
      id: listingId,
      submittedAt: new Date().toISOString(),
      submission: input,
      submittedByUserId: row.managerUserId ?? owner,
    },
    listingId,
  );

  const nextRow = mockToAdminRow(prop, listingId);
  side.requestChange[idx] = {
    ...nextRow,
    adminRefId,
    managerUserId: row.managerUserId,
    editRequestNote: row.editRequestNote,
    submission: normalizeManagerListingSubmissionV1(input),
    listingId,
  };

  writeSideStorage(side, forManagerUserId);
  mirrorAdminPropertyRecord({
    id: adminRefId,
    managerUserId: owner,
    status: "request_change",
    rowData: side.requestChange[idx],
    editRequestNote: row.editRequestNote,
  });
  return true;
}

export function unlistManagerListing(listingId: string, forManagerUserId?: string | null): boolean {
  const removed = removeExtraListing(listingId);
  if (!removed) return false;
  const side = readSide(forManagerUserId);
  side.unlisted.push(mockToAdminRow(removed, listingId));
  writeSideStorage(side, forManagerUserId);
  const next = side.unlisted[side.unlisted.length - 1]!;
  mirrorAdminPropertyRecord({ id: next.adminRefId, managerUserId: next.managerUserId ?? forManagerUserId, status: "unlisted", rowData: next });
  return true;
}

export function listAdminRow(row: AdminPropertyRow, forManagerUserId?: string | null): string | null {
  const side = readSide(forManagerUserId);
  const idx = side.unlisted.findIndex((r) => r.adminRefId === row.adminRefId);
  if (idx === -1) return null;
  const listingId =
    row.listingId ?? `mgr-${slugPart(row.buildingName)}-${slugPart(row.unitLabel)}-${row.adminRefId.slice(-6)}`;
  const owner = row.managerUserId ?? forManagerUserId ?? LEGACY_MANAGER_SCOPE_USER_ID;
  const prop = row.submission
    ? buildMockPropertyFromDraft({ ...row, id: listingId, submittedAt: new Date().toISOString(), submission: row.submission, submittedByUserId: owner }, listingId)
    : buildMockPropertyFromAdminRow(row, listingId);
  // Relisting transitions the SAME record `unlisted` -> `live` IN PLACE: every
  // unlisted row comes from `unlistManagerListing`, which stores it via
  // `mockToAdminRow(removed, listingId)`, so `adminRefId === listingId` and the
  // upsert `appendExtraListing` mirrors already carries that id. Never pair it
  // with a delete of the same id — that was a fire-and-forget delete aimed at
  // the row a fire-and-forget upsert had just written, and it only looked
  // harmless while the next mirror happened to re-create the row from the local
  // copy. Once the plan cap can refuse the upsert, the delete would still land:
  // the listing would be gone from `manager_property_records` (with
  // `clearHousingAccessForDeletedProperty` stripping co-manager grants and
  // scrubbing resident housing for that id) and survive only in this browser.
  appendExtraListing({ ...prop, managerUserId: owner, adminPublishLive: true }, owner);
  const nextUn = [...side.unlisted.slice(0, idx), ...side.unlisted.slice(idx + 1)];
  writeSideStorage({ ...side, unlisted: nextUn }, forManagerUserId);
  return listingId;
}

/**
 * Build the draft list-row (summary fields + the full submission for resume)
 * from an in-progress wizard submission. Never publishes anything.
 */
function submissionToDraftAdminRow(
  input: ManagerPropertyDraftInput,
  managerUserId: string,
  listingId: string,
  opts?: { stepIndex?: number | null; maxStepReached?: number | null; provisionalId?: boolean },
): AdminPropertyRow {
  const legacy = deriveLegacyFields(input);
  const pendingLike: ManagerPendingPropertyRow = {
    ...legacy,
    id: listingId,
    submittedAt: new Date().toISOString(),
    submission: input,
    submittedByUserId: managerUserId,
  };
  const prop = buildMockPropertyFromDraft(pendingLike, listingId);
  const step = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined;
  return {
    ...mockToAdminRow(prop, listingId),
    adminRefId: listingId,
    listingId,
    managerUserId,
    submission: normalizeManagerListingSubmissionV1(input),
    draftStepIndex: step(opts?.stepIndex),
    draftMaxStepReached: step(opts?.maxStepReached),
    draftIdProvisional: opts?.provisionalId === true ? true : undefined,
  };
}

/**
 * `mgr-<building>-<unit>-<rand>` once a property name exists, otherwise a neutral
 * id. The suffix carries a random component as well as the clock because this id
 * is both the record primary key and the permanent public listing URL — two mints
 * in the same millisecond must not collide.
 */
function mintManagerPropertyId(legacy: { buildingName: string; unitLabel: string }): string {
  const suffix = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 8)}`;
  const nameSlug = slugPart(legacy.buildingName);
  return nameSlug ? `mgr-${nameSlug}-${slugPart(legacy.unitLabel)}-${suffix}` : `mgr-listing-${suffix}`;
}

export type SaveManagerPropertyDraftOptions = {
  existingDraftId?: string | null;
  /** Wizard position to restore when the draft is resumed. */
  stepIndex?: number | null;
  maxStepReached?: number | null;
  /**
   * Allow re-keying a draft whose id was minted before it had a property name.
   * Only safe while the caller owns the draft id (the wizard that minted it) —
   * a resumed draft keeps its id so the surface rendering it does not lose the
   * open editor when the row key changes.
   */
  allowIdUpgrade?: boolean;
  /**
   * Receives the server's explanation when the write is refused, so the wizard
   * can show WHY rather than blaming the connection. See
   * `upsertPropertyRecordToServer`.
   */
  onError?: (message: string, code?: string) => void;
};

/**
 * Save (or update) an in-progress "add property" wizard as a private draft. The
 * DB record id doubles as the eventual live listingId, so publishing a draft
 * (see publishManagerPropertyDraftToServer) reuses the same id and simply flips
 * the status live. Because of that, a draft saved before the manager typed a
 * property name gets a neutral `mgr-listing-<rand>` id rather than a blank-slug
 * one, and is re-keyed to the real name-derived id on the first later save that
 * has a name. Returns the draft/listing id, or null on failure.
 */
export async function saveManagerPropertyDraftToServer(
  input: ManagerPropertyDraftInput,
  managerUserId: string,
  opts?: SaveManagerPropertyDraftOptions,
): Promise<string | null> {
  if (!managerUserId.trim()) return null;
  const legacy = deriveLegacyFields(input);
  const existingId = opts?.existingDraftId?.trim() ?? "";
  const existingRow = existingId
    ? readSide(managerUserId).drafts.find((r) => r.adminRefId === existingId) ?? null
    : null;
  const hasName = slugPart(legacy.buildingName).length > 0;

  let listingId = existingId;
  let provisionalId = existingRow?.draftIdProvisional === true;
  let staleDraftId: string | null = null;
  if (!existingId) {
    listingId = mintManagerPropertyId(legacy);
    provisionalId = !hasName;
  } else if (provisionalId && hasName && opts?.allowIdUpgrade) {
    listingId = mintManagerPropertyId(legacy);
    provisionalId = false;
    staleDraftId = existingId;
  }

  const row = submissionToDraftAdminRow(input, managerUserId, listingId, {
    stepIndex: opts?.stepIndex,
    maxStepReached: opts?.maxStepReached,
    provisionalId,
  });
  const ok = await upsertPropertyRecordToServer({
    id: listingId,
    managerUserId,
    status: "draft",
    rowData: row,
    onError: opts?.onError,
  });
  if (!ok) return null;
  // Write BEFORE delete on an id re-key: the re-keyed row is safely on the server
  // before the superseded one goes, so a failed save can never leave the draft
  // with no record at all. A transient duplicate draft is visible and deletable;
  // a vanished draft is silent data loss, and preventing that loss is the entire
  // point of this feature. When the delete fails the stale row stays in the list
  // (rather than being hidden and resurrected by the next sync) so the manager
  // can remove it.
  const staleDelete = staleDraftId ? await deletePropertyRecordFromServer(staleDraftId) : false;
  // Re-read the side buckets AFTER the round-trip: a concurrent list/unlist or a
  // pipeline sync may have rewritten them while the save was in flight, and
  // writing back the pre-await snapshot would silently drop that change.
  const fresh = readSide(managerUserId);
  const remaining = staleDelete ? fresh.drafts.filter((r) => r.adminRefId !== staleDraftId) : fresh.drafts;
  const idx = remaining.findIndex((r) => r.adminRefId === listingId);
  const drafts = idx === -1 ? [...remaining, row] : remaining.map((r, i) => (i === idx ? row : r));
  // writeSideStorage dispatches PROPERTY_PIPELINE_EVENT, whose listeners already
  // re-sync from the server — an explicit force sync here would just triple the
  // egress of a button a manager can press on every wizard step.
  writeSideStorage({ ...fresh, drafts }, managerUserId);
  return listingId;
}

/**
 * Publish a saved draft: promote it to a live listing (same id) and drop it from
 * the drafts bucket. Callers must enforce the plan property limit BEFORE calling
 * — a draft does not count toward the limit until it is published.
 */
export async function publishManagerPropertyDraftToServer(
  draftId: string,
  input: ManagerPropertyDraftInput,
  managerUserId: string,
  opts?: { onError?: (message: string) => void },
): Promise<string | null> {
  if (!managerUserId.trim() || !draftId.trim()) return null;
  const listingId = draftId.trim();
  if (!(await publishManagerListingSubmissionToServer(listingId, input, managerUserId, opts))) return null;
  const side = readSide(managerUserId);
  const nextDrafts = side.drafts.filter((r) => r.adminRefId !== listingId);
  if (nextDrafts.length !== side.drafts.length) {
    writeSideStorage({ ...side, drafts: nextDrafts }, managerUserId);
  }
  await syncPropertyPipelineFromServer({ force: true });
  return listingId;
}

/**
 * Every submission still held by a locally-known record: the remaining side
 * buckets, the live/co-managed listing catalog and the pending queue. Uploads are
 * deduplicated per data URL, so records can share bucket objects — media cleanup
 * has to diff against this rather than assume a deleted row owned its media
 * exclusively.
 */
function survivingSubmissions(forManagerUserId?: string | null): ManagerListingSubmissionV1[] {
  const side = readSide(forManagerUserId);
  const out: ManagerListingSubmissionV1[] = [];
  for (const rows of [side.drafts, side.unlisted, side.requestChange, side.rejected]) {
    for (const row of rows) if (row.submission) out.push(row.submission);
  }
  for (const listing of readAllExtraListings()) {
    if (listing.listingSubmission) out.push(listing.listingSubmission);
  }
  for (const pending of readAllPendingManagerProperties()) {
    if (pending.submission) out.push(pending.submission);
  }
  return out;
}

/**
 * Permanently delete a saved draft (owner-only). Resolves false — leaving the
 * draft in place — unless the server row is actually gone, so a delete that never
 * landed is reported rather than reappearing on the next sync. Its uploads are
 * reclaimed afterwards, minus any object another surviving record still points at.
 */
export async function deleteManagerPropertyDraft(
  draftId: string,
  forManagerUserId?: string | null,
): Promise<boolean> {
  const existing = readSide(forManagerUserId).drafts.find((r) => r.adminRefId === draftId);
  if (!existing) return false;
  if (!(await deletePropertyRecordFromServer(draftId))) return false;
  const fresh = readSide(forManagerUserId);
  const nextDrafts = fresh.drafts.filter((r) => r.adminRefId !== draftId);
  writeSideStorage({ ...fresh, drafts: nextDrafts }, forManagerUserId);
  await deleteSubmissionMediaObjects(existing.submission, survivingSubmissions(forManagerUserId));
  return true;
}

export function moveListedToRequestChange(
  listingId: string,
  forManagerUserId?: string | null,
  editRequestNote?: string,
): boolean {
  const removed = removeExtraListing(listingId);
  if (!removed) return false;
  const side = readSide(forManagerUserId);
  const note = editRequestNote?.trim();
  side.requestChange.push({
    ...mockToAdminRow(removed, listingId),
    ...(note ? { editRequestNote: note } : {}),
  });
  writeSideStorage(side, forManagerUserId);
  const next = side.requestChange[side.requestChange.length - 1]!;
  mirrorAdminPropertyRecord({
    id: next.adminRefId,
    managerUserId: next.managerUserId ?? forManagerUserId,
    status: "request_change",
    rowData: next,
    editRequestNote: note,
  });
  return true;
}

export function moveListedToRejected(listingId: string, forManagerUserId?: string | null): boolean {
  if (!adminListingRejectAllowed()) return false;
  const removed = removeExtraListing(listingId);
  if (!removed) return false;
  const side = readSide(forManagerUserId);
  side.rejected.push({ ...mockToAdminRow(removed, listingId), adminRefId: newAdminRefId() });
  writeSideStorage(side, forManagerUserId);
  const next = side.rejected[side.rejected.length - 1]!;
  mirrorAdminPropertyRecord({ id: next.adminRefId, managerUserId: next.managerUserId ?? forManagerUserId, status: "rejected", rowData: next });
  return true;
}

export function moveUnlistedToRejected(adminRefId: string, forManagerUserId?: string | null): boolean {
  if (!adminListingRejectAllowed()) return false;
  const side = readSide(forManagerUserId);
  const idx = side.unlisted.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const row = side.unlisted[idx]!;
  const next = [...side.unlisted.slice(0, idx), ...side.unlisted.slice(idx + 1)];
  side.rejected.push({ ...row, adminRefId: newAdminRefId() });
  writeSideStorage({ ...side, unlisted: next }, forManagerUserId);
  deleteMirroredPropertyRecord(adminRefId);
  const rejected = side.rejected[side.rejected.length - 1]!;
  mirrorAdminPropertyRecord({ id: rejected.adminRefId, managerUserId: rejected.managerUserId ?? forManagerUserId, status: "rejected", rowData: rejected });
  return true;
}

export function restoreRejectedToPending(adminRefId: string, forManagerUserId?: string | null): boolean {
  const side = readSide(forManagerUserId);
  const idx = side.rejected.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const row = side.rejected[idx]!;
  const nextR = [...side.rejected.slice(0, idx), ...side.rejected.slice(idx + 1)];
  const uid = row.managerUserId ?? forManagerUserId ?? LEGACY_MANAGER_SCOPE_USER_ID;
  submitManagerPendingProperty(legacyAdminFieldsToSubmission(row), uid);
  writeSideStorage({ ...side, rejected: nextR }, forManagerUserId);
  deleteMirroredPropertyRecord(adminRefId);
  return true;
}

/** Permanently removes a row from the rejected bucket (demo localStorage). */
export function removeRejectedProperty(adminRefId: string, forManagerUserId?: string | null): boolean {
  const side = readSide(forManagerUserId);
  const idx = side.rejected.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const nextR = [...side.rejected.slice(0, idx), ...side.rejected.slice(idx + 1)];
  writeSideStorage({ ...side, rejected: nextR }, forManagerUserId);
  deleteMirroredPropertyRecord(adminRefId);
  return true;
}

/** Previously seeded demo rows for manager side-buckets; disabled until the real flow ships. */
export function ensureDemoManagerSideBucketsSeed(): void {
  /* no-op */
}

/** Permanently removes a live mgr-* listing from the portal (does not move to Unlisted). */
export function deleteManagerLiveListing(listingId: string, forManagerUserId: string | null): boolean {
  if (!forManagerUserId?.trim()) return false;
  const extras = readExtraListingsForUser(forManagerUserId);
  const hit = extras.find((p) => p.id === listingId);
  if (!hit || !hit.id.startsWith("mgr-")) return false;
  const ok = removeExtraListing(listingId) !== null;
  if (ok) deleteMirroredPropertyRecord(listingId);
  return ok;
}

/** Drops a row from the manager-only unlisted queue (does not restore a public listing). */
export function deleteUnlistedManagerProperty(adminRefId: string, forManagerUserId: string | null): boolean {
  const side = readSide(forManagerUserId);
  const idx = side.unlisted.findIndex((r) => r.adminRefId === adminRefId);
  if (idx === -1) return false;
  const nextUn = [...side.unlisted.slice(0, idx), ...side.unlisted.slice(idx + 1)];
  writeSideStorage({ ...side, unlisted: nextUn }, forManagerUserId);
  deleteMirroredPropertyRecord(adminRefId);
  return true;
}
