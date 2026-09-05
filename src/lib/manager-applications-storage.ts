import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import {
  computeLeaseEndDate,
  normalizeIsoDateInput,
  resolvePlacementLeaseDates,
  shouldAutoComputeLeaseEnd,
} from "@/lib/rental-application/lease-dates";
import {
  isDraftShapedApplicationRow,
  type DraftShapedRowFields,
} from "@/lib/rental-application/draft-shape";
import { resolveApplicationPersonalFields } from "@/lib/application-personal-fields";
import { notePortalResponse, onPortalSessionViewerChange, portalSessionEnded } from "@/lib/auth/portal-session-gate";
import {
  defaultBackgroundCheckStatusForRow,
  normalizeBackgroundCheckStatus,
  resolveBackgroundCheckStatus,
} from "@/lib/application-background-check";

export const MANAGER_APPLICATIONS_EVENT = "axis:manager-applications";
const MANAGER_APPLICATIONS_SESSION_KEY_PREFIX = "axis:manager-applications:v2";

const EMPTY_FALLBACK: DemoApplicantRow[] = [];
let memoryRows: DemoApplicantRow[] = [];
let activeApplicationsScopeUserId: string | undefined;
const MANAGER_APPLICATIONS_SYNC_TTL_MS = 15_000;
let managerApplicationsLastSyncedAt = 0;
let managerApplicationsSyncPromise: Promise<DemoApplicantRow[]> | null = null;
let publicApprovedApplicationsLastSyncedAt = 0;
let publicApprovedApplicationsSyncPromise: Promise<DemoApplicantRow[]> | null = null;
let applicationsScopeGeneration = 0;
let applicationWriteGeneration = 0;

function clearSensitiveApplicationCache() {
  const changed = memoryRows.length > 0;
  memoryRows = [];
  applicationsScopeGeneration++;
  managerApplicationsLastSyncedAt = 0;
  publicApprovedApplicationsLastSyncedAt = 0;
  managerApplicationsSyncPromise = null;
  publicApprovedApplicationsSyncPromise = null;
  if (changed) emit();
}

onPortalSessionViewerChange((viewerId) => {
  if (isDemoModeActive()) return;
  clearQueuedApplicationIdentity();
  activeApplicationsScopeUserId = viewerId ?? undefined;
  clearSensitiveApplicationCache();
});

export function normalizeApplicationAxisId(id: unknown): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return raw;
  // Pre-rebrand applications keep their AXIS- ids; new ones are PROPLANE-.
  const upper = raw.toUpperCase();
  if (upper.startsWith("AXIS-") || upper.startsWith("PROPLANE-")) return raw;
  const suffix = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 12);
  return `PROPLANE-${suffix || Date.now().toString(36).toUpperCase()}`;
}

/** Opens Property Portal → Applications with this primary application expanded. */
export function buildPortalApplicationOpenHref(axisId: string): string {
  const id = normalizeApplicationAxisId(axisId.trim()).toUpperCase();
  if (!id) return "/portal/applications";
  return `/portal/applications?open=${encodeURIComponent(id)}`;
}

/** Approved application id for a resident email when unambiguous (exactly one approved row). */
export function approvedApplicationAxisIdForResidentEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const approved = readManagerApplicationRows().filter(
    (row) => row.bucket === "approved" && row.email?.trim().toLowerCase() === normalized,
  );
  if (approved.length !== 1) return null;
  return approved[0]!.id.trim() || null;
}

/** Same application id shown in property portal + create-account; not derived from auth user UUID. */
export function resolveResidentPortalAxisId(input: {
  profileManagerId?: string | null;
  authUserAxisId?: string | null;
  applicationRowId?: string | null;
  /** Wins over drifted profiles.manager_id when the resident has one clear approved application. */
  approvedApplicationRowId?: string | null;
}): string {
  const fromApproved = input.approvedApplicationRowId?.trim();
  if (fromApproved) return normalizeApplicationAxisId(fromApproved);
  const fromProfile = input.profileManagerId?.trim();
  if (fromProfile) return normalizeApplicationAxisId(fromProfile);
  const fromAuth = typeof input.authUserAxisId === "string" ? input.authUserAxisId.trim() : "";
  if (fromAuth) return normalizeApplicationAxisId(fromAuth);
  const fromRow = input.applicationRowId?.trim();
  if (fromRow) return normalizeApplicationAxisId(fromRow);
  return "";
}

function normalizeApplicationLeaseFields(row: DemoApplicantRow): DemoApplicantRow {
  if (!row.application) return row;
  const app = row.application;
  const leaseTerm = typeof app.leaseTerm === "string" ? app.leaseTerm.trim() : "";
  const leaseStart = normalizeIsoDateInput(app.leaseStart);
  let leaseEnd = leaseTerm === "Month-to-Month" ? "" : normalizeIsoDateInput(app.leaseEnd);
  if (!leaseEnd && shouldAutoComputeLeaseEnd(leaseTerm, app.rentalType) && leaseStart) {
    leaseEnd = computeLeaseEndDate(leaseStart, leaseTerm);
  }
  const storedLeaseStart = typeof app.leaseStart === "string" ? app.leaseStart.trim() : "";
  const storedLeaseEnd = typeof app.leaseEnd === "string" ? app.leaseEnd.trim() : "";
  if (leaseStart === storedLeaseStart && leaseEnd === storedLeaseEnd) return row;
  return {
    ...row,
    application: {
      ...app,
      leaseStart,
      leaseEnd,
    },
  };
}

function normalizeApplicationRow(row: DemoApplicantRow): DemoApplicantRow {
  const nextId = normalizeApplicationAxisId(row.id);
  const next = nextId === row.id ? row : { ...row, id: nextId };
  const withRent = syncSignedRentFields(normalizeApplicationLeaseFields(next));
  const backgroundCheckStatus =
    normalizeBackgroundCheckStatus(withRent.backgroundCheckStatus) ??
    defaultBackgroundCheckStatusForRow(withRent);
  return backgroundCheckStatus === withRent.backgroundCheckStatus
    ? withRent
    : { ...withRent, backgroundCheckStatus };
}

function parseSignedRentValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed.replace(/[^\d.]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : null;
  }
  return null;
}

function syncSignedRentFields(row: DemoApplicantRow): DemoApplicantRow {
  const signedMonthlyRent = parseSignedRentValue(row.signedMonthlyRent);
  const applicationRent = parseSignedRentValue(row.application?.managerRentOverride);
  const canonicalRent = signedMonthlyRent ?? applicationRent;
  if (canonicalRent == null) return row;

  return {
    ...row,
    signedMonthlyRent: canonicalRent,
    application: row.application
      ? {
          ...row.application,
          managerRentOverride: String(canonicalRent),
        }
      : row.application,
  };
}

function normalizeApplicationRows(rows: DemoApplicantRow[]): DemoApplicantRow[] {
  const byId = new Map<string, DemoApplicantRow>();
  for (const row of rows) {
    const normalized = normalizeApplicationRow(row);
    byId.set(normalized.id, { ...byId.get(normalized.id), ...normalized });
  }
  return [...byId.values()];
}

function applicationRowsChanged(a: DemoApplicantRow[], b: DemoApplicantRow[]) {
  return JSON.stringify(normalizeApplicationRows(a)) !== JSON.stringify(normalizeApplicationRows(b));
}

/**
 * A pending row still being filled in by the applicant (not yet submitted).
 *
 * Deliberately withdrawn-agnostic and narrower than `isInProgressApplicationRow`:
 * this is the persistence guard, and it must mirror the conditional UPDATE in
 * `persistDraftRow` (bucket `pending` + stage "In progress"), which already
 * refuses a withdrawn row in SQL. Treating a withdrawn draft as "not a draft"
 * here would route it down the unconditional upsert instead and let a late
 * autosave revive it.
 */
export function isDraftApplicationRow(row: Pick<DemoApplicantRow, "bucket" | "stage">): boolean {
  return row.bucket === "pending" && String(row.stage ?? "").trim().toLowerCase() === "in progress";
}

/**
 * True when writing `incoming` over `existing` would revert an application that
 * is already submitted back to an unsubmitted draft.
 *
 * The wizard fires an unawaited draft sync on every form change, so one of those
 * writes is routinely still in flight when the submit write lands. Both carry the
 * same axis id and both succeed, so whichever lands last wins — and when the
 * draft wins, the manager never sees the application and the resident is left
 * looking at a draft. Nothing legitimately moves an application backwards into
 * "In progress", so the draft write is the one to drop.
 */
export function wouldDowngradeSubmittedApplication(
  existing: DraftShapedRowFields | null | undefined,
  incoming: Pick<DemoApplicantRow, "bucket" | "stage">,
): boolean {
  if (!existing) return false;
  // The two sides deliberately use DIFFERENT predicates.
  //
  // `incoming` uses the exact `isDraftApplicationRow` (bucket `pending` + stage
  // "In progress"), because that is what the wizard's own autosave writes and it
  // must mirror the conditional UPDATE in `persistDraftRow`.
  //
  // `existing` uses the WIDER `isDraftShapedApplicationRow`, because a cached row
  // can be a legacy draft whose stage is blank, `draft`, `started` or `incomplete`.
  // Testing the existing row with the exact predicate read those as
  // already-submitted, so every later autosave looked like a submitted -> draft
  // downgrade and `syncInProgressApplicationRow` returned early forever: the draft
  // silently stopped saving, with no error and no toast. A genuinely submitted row
  // is still rejected by the wider predicate (`isSubmittedStage` excludes it), so
  // the submit-race guard this function exists for is unchanged.
  return isDraftApplicationRow(incoming) && !isDraftShapedApplicationRow(existing);
}

function chooseString(primary: string | undefined, fallback: string | undefined): string | undefined {
  const p = primary?.trim();
  if (p) return primary;
  const f = fallback?.trim();
  if (f) return fallback;
  return primary ?? fallback;
}

function chooseNumber(primary: number | null | undefined, fallback: number | null | undefined): number | null | undefined {
  return primary ?? fallback;
}

function mergeApplicationRow(existing: DemoApplicantRow | undefined, incoming: DemoApplicantRow): DemoApplicantRow {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    name: chooseString(incoming.name, existing.name) ?? "",
    property: chooseString(incoming.property, existing.property) ?? "",
    stage: chooseString(incoming.stage, existing.stage) ?? "",
    detail: chooseString(incoming.detail, existing.detail) ?? "",
    email: chooseString(incoming.email, existing.email),
    propertyId: chooseString(incoming.propertyId, existing.propertyId),
    assignedPropertyId: chooseString(incoming.assignedPropertyId, existing.assignedPropertyId),
    assignedRoomChoice: chooseString(incoming.assignedRoomChoice, existing.assignedRoomChoice),
    managerUserId: chooseString(incoming.managerUserId ?? undefined, existing.managerUserId ?? undefined) ?? null,
    moveInInstructions: chooseString(incoming.moveInInstructions, existing.moveInInstructions),
    signedMonthlyRent: chooseNumber(incoming.signedMonthlyRent, existing.signedMonthlyRent),
    backgroundCheckStatus:
      normalizeBackgroundCheckStatus(incoming.backgroundCheckStatus) ??
      normalizeBackgroundCheckStatus(existing.backgroundCheckStatus) ??
      resolveBackgroundCheckStatus({ ...existing, ...incoming }),
    manuallyAdded: incoming.manuallyAdded ?? existing.manuallyAdded,
    application: incoming.application ?? existing.application,
    manualResidentDetails: incoming.manualResidentDetails ?? existing.manualResidentDetails,
    // `withdrawnAt` intentionally follows the server (`...incoming` above), NOT a
    // sticky local stamp: withdrawal is FINAL for the applicant (reapplying to
    // the same property starts a brand-new application — see `confirmWithdraw`
    // and the withdrawn-row exclusion in `findInProgressRowForTarget`), so no
    // un-withdraw path exists to revive a row. Removal is already durable
    // without stickiness — the withdraw route persists `withdrawnAt` server-side
    // (GET returns it via `normalizeRow`), the union merge keeps a local-only
    // (404, not-yet-synced) row it can't see on the server, and `confirmWithdraw`
    // marks the cache immediately. A sticky stamp would instead permanently hide
    // any future row that reused the id, which is exactly the reapply we want.
  };
}

/**
 * Union merge: every id from EITHER side survives — `incomingRows` (the
 * server's response) wins per-field on ids present in both, via
 * `mergeApplicationRow`; an id present ONLY in `existingRows` is kept as-is.
 *
 * This is load-bearing, not cosmetic. The wizard's per-keystroke sync effect
 * writes a freshly-created in-progress row to the LOCAL cache immediately,
 * then fires an async, un-awaited POST to persist it — there is always a
 * window where the row exists locally but not yet on the server. A caller
 * that force-refetches during that window (`syncManagerApplicationsFromServer`
 * on mount, `syncPublicApprovedApplicationsFromServer`'s approved-only
 * snapshot) must never treat "missing from this response" as "deleted", or it
 * erases the row the user is actively filling out. Losing it from
 * `memoryRows` doesn't just blank a field — `ResidentApplicationsPanel`
 * relocates the SAME wizard to a different JSX position depending on whether
 * a matching in-progress row exists (top-level standalone vs. embedded in an
 * expanded table row), so the row vanishing and reappearing unmounts and
 * remounts `RentalApplicationWizard`, resetting `step` back to 1 — the
 * "glitches back to the start of the application" bug. Losing rows here also
 * fed a thundering herd: each remount re-runs the wizard's own
 * force-refetch-on-mount effect, which raced the still-in-flight POST again.
 * Regression coverage: `tests/unit/manager-applications-merge-rows.test.ts`.
 *
 * Deliberate tradeoff (accepted): because the union never treats "missing from
 * a server response" as "deleted", a row deleted server-side (e.g. from
 * another tab or device) does NOT propagate into a tab that already holds it —
 * and `writeManagerApplicationRows`'s `action: "replace"` mirror of the whole
 * cache can then re-upload that row, resurrecting the deletion. Distinguishing
 * "not yet synced locally" from "deleted remotely" requires a server-side
 * deletion/tombstone signal, which is tracked as follow-up work.
 */
export function mergeApplicationRows(existingRows: DemoApplicantRow[], incomingRows: DemoApplicantRow[]): DemoApplicantRow[] {
  const existingById = new Map(normalizeApplicationRows(existingRows).map((row) => [row.id, row] as const));
  const incomingById = new Map(incomingRows.map((row) => [normalizeApplicationRow(row).id, row] as const));
  const mergedIds = new Set<string>([...existingById.keys(), ...incomingById.keys()]);
  const merged: DemoApplicantRow[] = [];
  for (const id of mergedIds) {
    const incoming = incomingById.get(id);
    if (incoming) {
      merged.push(mergeApplicationRow(existingById.get(id), normalizeApplicationRow(incoming)));
    } else {
      const existingOnly = existingById.get(id);
      if (existingOnly) merged.push(existingOnly);
    }
  }
  return normalizeApplicationRows(merged);
}

function canUseStorage() {
  return typeof window !== "undefined";
}

function managerApplicationsSessionKey(scopeUserId?: string | null): string {
  // Demo sandbox: one shared store for every scope so the demo manager and
  // demo resident act on the same application rows (mirrors the lease store).
  if (isDemoModeActive()) return `${MANAGER_APPLICATIONS_SESSION_KEY_PREFIX}:shared`;
  if (scopeUserId) return `${MANAGER_APPLICATIONS_SESSION_KEY_PREFIX}:${scopeUserId}`;
  return `${MANAGER_APPLICATIONS_SESSION_KEY_PREFIX}:shared`;
}

function ensureApplicationsScope(scopeUserId?: string | null) {
  const nextScope = isDemoModeActive() ? undefined : scopeUserId ?? undefined;
  if (activeApplicationsScopeUserId !== nextScope) {
    activeApplicationsScopeUserId = nextScope;
    clearSensitiveApplicationCache();
  }
}

function purgePersistentApplicationRows() {
  if (!canUseStorage()) return;
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(`${MANAGER_APPLICATIONS_SESSION_KEY_PREFIX}:`)) window.sessionStorage.removeItem(key);
    }
  } catch { /* Storage can be unavailable in privacy mode. */ }
}

function hydrateManagerApplicationsFromSession(scopeUserId?: string | null) {
  if (!canUseStorage()) return;
  if (!isDemoModeActive()) {
    purgePersistentApplicationRows();
    return;
  }
  if (memoryRows.length > 0) return;
  try {
    const raw = window.sessionStorage.getItem(managerApplicationsSessionKey(scopeUserId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as DemoApplicantRow[];
    if (!Array.isArray(parsed)) return;
    memoryRows = normalizeApplicationRows(parsed);
  } catch {
    /* ignore */
  }
}

function persistManagerApplicationsToSession(rows: DemoApplicantRow[], scopeUserId?: string | null) {
  if (!canUseStorage()) return;
  if (!isDemoModeActive()) {
    purgePersistentApplicationRows();
    return;
  }
  try {
    window.sessionStorage.setItem(
      managerApplicationsSessionKey(scopeUserId ?? activeApplicationsScopeUserId),
      JSON.stringify(rows),
    );
  } catch {
    /* ignore */
  }
}

function emit() {
  if (!canUseStorage()) return;
  window.dispatchEvent(new Event(MANAGER_APPLICATIONS_EVENT));
}

function mirrorApplicationsToServer(rows: DemoApplicantRow[]) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/manager-applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "replace", rows }),
  }).catch(() => undefined);
}

/**
 * Fired after each background in-progress save attempt so a surface can tell the
 * user their work is (or is not) being persisted. `detail.ok` is false when the
 * write failed; `detail.id` is the application id it was for. The rental wizard
 * listens for this to raise a "couldn't save" banner instead of silently losing
 * a resident's typing — a failed autosave must surface, never disappear.
 */
export const APPLICATION_SAVE_STATUS_EVENT = "axis:application-save-status";

function emitApplicationSaveStatus(ok: boolean, id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(APPLICATION_SAVE_STATUS_EVENT, { detail: { ok, id } }));
}

/**
 * Guest autosaves return the row's resident-setup token for photo uploads and
 * emailed resume links. When the browser still holds a valid token it is echoed
 * back unchanged so links in a sent email are not invalidated by later autosaves.
 */
const APPLICATION_SETUP_TOKEN_STORE_PREFIX = "axis.applicationSetupToken.";

function applicationSetupTokenKey(id: string): string {
  return normalizeApplicationAxisId(id).toUpperCase();
}

export function rememberApplicationSetupToken(id: string, token: string): void {
  const key = applicationSetupTokenKey(id);
  if (!key || !token || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(APPLICATION_SETUP_TOKEN_STORE_PREFIX + key, token);
  } catch {
    /* ignore */
  }
}

export function getApplicationSetupToken(id: string): string | null {
  const key = applicationSetupTokenKey(id);
  if (!key || typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(APPLICATION_SETUP_TOKEN_STORE_PREFIX + key);
  } catch {
    return null;
  }
}

function mirrorApplicationRowToServer(row: DemoApplicantRow): Promise<void> {
  if (typeof window === "undefined" || isDemoModeActive()) return Promise.resolve();
  const generation = applicationWriteGeneration;
  const setupToken = getApplicationSetupToken(row.id);
  return fetch("/api/manager-applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      action: "upsert",
      row,
      ...(setupToken ? { setupToken } : {}),
    }),
  })
    .then(async (res) => {
      if (generation !== applicationWriteGeneration) return;
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { setupToken?: string } | null;
        if (generation !== applicationWriteGeneration) return;
        if (typeof body?.setupToken === "string" && body.setupToken) {
          rememberApplicationSetupToken(row.id, body.setupToken);
        }
      }
      emitApplicationSaveStatus(res.ok, row.id);
    })
    .catch(() => {
      if (generation === applicationWriteGeneration) emitApplicationSaveStatus(false, row.id);
    });
}

const UPSERT_DEBOUNCE_MS = 400;
type UpsertQueueEntry = {
  latest: DemoApplicantRow | null;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
};
const upsertQueues = new Map<string, UpsertQueueEntry>();

function clearQueuedApplicationIdentity() {
  applicationWriteGeneration++;
  for (const entry of upsertQueues.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.latest = null;
  }
  upsertQueues.clear();
  if (typeof window === "undefined") return;
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(APPLICATION_SETUP_TOKEN_STORE_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch { /* Storage can be unavailable. */ }
}

/**
 * Best-effort flush when the page is being hidden or torn down: the debounced
 * queue can be holding the final edits (including a just-advanced wizardStep)
 * for up to 400ms — or longer, behind an in-flight write — and a closed tab
 * loses them, since the local mirror is memory-only. `keepalive: true` lets
 * the request outlive the page. Deliberately leaves `latest` and the timer
 * untouched: if the page survives (a mere tab switch), the normal serialized
 * path re-sends the identical snapshot, which also heals any ordering race
 * this out-of-band send could introduce and keeps save-status events firing.
 */
function flushPendingApplicationRowUpserts() {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  for (const entry of upsertQueues.values()) {
    const pending = entry.latest;
    if (!pending) continue;
    const setupToken = getApplicationSetupToken(pending.id);
    void fetch("/api/manager-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify({
        action: "upsert",
        row: pending,
        ...(setupToken ? { setupToken } : {}),
      }),
    }).catch(() => undefined);
  }
}

let upsertUnloadFlushRegistered = false;

function registerUpsertUnloadFlush() {
  if (upsertUnloadFlushRegistered || typeof window === "undefined") return;
  upsertUnloadFlushRegistered = true;
  window.addEventListener("pagehide", flushPendingApplicationRowUpserts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingApplicationRowUpserts();
  });
}

/**
 * The rental wizard calls this on every form change (a keystroke can fire
 * dozens of times per minute), and the server write is a full replace of
 * `row_data` — never a partial patch. Firing one raw fetch per call let
 * requests overlap in flight; because network completion order is not
 * guaranteed to match send order, a STALE snapshot (e.g. from before a room
 * was picked) could land on the server AFTER a newer one, silently reverting
 * the field the user just set. Coalescing to the latest snapshot after a
 * short quiet period, and never starting the next write for the same row id
 * until the previous one's request has actually landed, makes the server's
 * view monotonic with the user's edits again.
 */
function startQueuedWrite(entry: UpsertQueueEntry): void {
  const runNext = () => {
    const pending = entry.latest;
    entry.latest = null;
    if (!pending) return;
    entry.inFlight = mirrorApplicationRowToServer(pending).finally(() => {
      entry.inFlight = null;
      // A newer edit may have queued while this write was in flight.
      if (entry.latest) runNext();
    });
  };
  // Never overlap two writes for the same row — wait out any write already
  // in flight (e.g. from the trailing edge of the previous debounce) so
  // send order and landing order stay identical.
  if (entry.inFlight) void entry.inFlight.then(runNext);
  else runNext();
}

function scheduleApplicationRowUpsert(row: DemoApplicantRow) {
  const id = row.id.trim();
  if (!id) return;
  registerUpsertUnloadFlush();
  let entry = upsertQueues.get(id);
  if (!entry) {
    entry = { latest: null, timer: null, inFlight: null };
    upsertQueues.set(id, entry);
  }
  entry.latest = row;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry!.timer = null;
    startQueuedWrite(entry!);
  }, UPSERT_DEBOUNCE_MS);
}

/**
 * Drain this application's autosave queue NOW and wait for the writes to land.
 * A guest's photo credential is the resident-setup token the LATEST autosave
 * response carried, and every guest autosave rotates it — so a photo
 * upload/remove issued while a save is queued or in flight would race the
 * rotation and be refused. Settling first makes the stored token current at
 * request time. Bounded so a pathological queue can never hang the caller.
 */
export async function settlePendingApplicationRowUpserts(id: string): Promise<void> {
  if (typeof window === "undefined") return;
  const target = normalizeApplicationAxisId(id).toUpperCase();
  if (!target) return;
  for (const [key, entry] of upsertQueues) {
    if (normalizeApplicationAxisId(key).toUpperCase() !== target) continue;
    for (let i = 0; i < 20 && (entry.latest || entry.timer || entry.inFlight); i += 1) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        startQueuedWrite(entry);
      }
      if (entry.inFlight) await entry.inFlight.catch(() => undefined);
      else if (entry.latest) startQueuedWrite(entry);
    }
  }
}

export function upsertApplicationRowToServer(row: DemoApplicantRow): void {
  scheduleApplicationRowUpsert(row);
}

/**
 * Drop any queued (debounced, not-yet-sent) upsert for an application id so a
 * pre-withdraw snapshot is neither flushed by the timer nor beaconed by the
 * unload flush. A write already in flight cannot be recalled from here — the
 * server refuses to overwrite a withdrawn row instead. The queue entry itself
 * stays, keeping the in-flight serialization intact for any later schedule.
 */
export function cancelPendingApplicationRowUpsert(id: string): void {
  const target = normalizeApplicationAxisId(id).toUpperCase();
  if (!target) return;
  for (const [key, entry] of upsertQueues) {
    if (normalizeApplicationAxisId(key).toUpperCase() !== target) continue;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.latest = null;
  }
}

/** Await server persistence before showing post-submit UI or create-account links. */
export async function upsertApplicationRowToServerAwait(
  row: DemoApplicantRow,
  opts?: { existingResidentOnboarding?: { sendWelcomeEmail?: boolean } },
): Promise<{
  ok: boolean;
  error?: string;
  setupHref?: string;
  setupToken?: string;
  welcomeEmailSent?: boolean;
  leaseId?: string;
  mailtoHref?: string;
  row?: DemoApplicantRow;
}> {
  if (typeof window === "undefined") return { ok: false, error: "Not in browser." };
  if (isDemoModeActive()) return { ok: true };
  const generation = applicationWriteGeneration;
  try {
    const res = await fetch("/api/manager-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        action: "upsert",
        row,
        ...(opts?.existingResidentOnboarding ? { existingResidentOnboarding: opts.existingResidentOnboarding } : {}),
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      setupHref?: string;
      setupToken?: string;
      mailtoHref?: string;
      row?: DemoApplicantRow;
      existingResidentOnboarding?: {
        welcomeEmailSent?: boolean;
        leaseId?: string;
        axisId?: string;
      };
    } | null;
    if (generation !== applicationWriteGeneration) return { ok: false, error: "The active account changed. Reopen the application before saving." };
    if (!res.ok) {
      const errBody = body as { leaseId?: string; mailtoHref?: string } | null;
      return {
        ok: false,
        error: body?.error ?? "Could not save application.",
        mailtoHref: errBody?.mailtoHref,
        leaseId: errBody?.leaseId,
      };
    }
    // Guest submits return a server-authoritative setup handoff (token minted on
    // the row); the wizard uses it so the finish CTA never hinges on the email route.
    const setupHref =
      typeof body?.setupHref === "string" && body.setupHref.startsWith("/auth/resident-setup")
        ? body.setupHref
        : undefined;
    const setupToken = typeof body?.setupToken === "string" && body.setupToken ? body.setupToken : undefined;
    if (setupToken) rememberApplicationSetupToken(row.id, setupToken);
    if (body?.row?.id) {
      replaceManagerApplicationRowInCache(body.row);
    }
    const onboarding = body?.existingResidentOnboarding;
    return {
      ok: true,
      setupHref,
      setupToken,
      welcomeEmailSent: onboarding?.welcomeEmailSent,
      leaseId: onboarding?.leaseId,
      row: body?.row,
    };
  } catch {
    return { ok: false, error: "Could not save application." };
  }
}

export async function deleteManagerApplicationFromServer(id: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === "undefined" || !id.trim()) return { ok: false, error: "Application ID is required." };
  if (isDemoModeActive()) return { ok: true };
  try {
    const res = await fetch("/api/manager-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "delete", id }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) return { ok: false, error: body?.error ?? "Could not delete application." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not delete application." };
  }
}

export async function syncManagerApplicationsFromServer(opts?: {
  force?: boolean;
  managerUserId?: string | null;
  /** Resident portal: read only the caller's own applicant rows. */
  selfScope?: boolean;
}): Promise<DemoApplicantRow[]> {
  if (!canUseStorage()) return [];
  const managerUserId = opts?.managerUserId ?? undefined;
  ensureApplicationsScope(managerUserId);
  hydrateManagerApplicationsFromSession(managerUserId);
  if (isDemoModeActive()) return readManagerApplicationRows();
  // Stop polling once the session is gone — this loader runs on an interval and
  // otherwise keeps 401ing for as long as the signed-out tab stays open.
  if (activeApplicationsScopeUserId && portalSessionEnded()) {
    clearQueuedApplicationIdentity();
    clearSensitiveApplicationCache();
    return [];
  }
  const force = opts?.force === true;
  if (!force && managerApplicationsSyncPromise) return managerApplicationsSyncPromise;
  if (!force && managerApplicationsLastSyncedAt > 0 && Date.now() - managerApplicationsLastSyncedAt < MANAGER_APPLICATIONS_SYNC_TTL_MS) {
    return readManagerApplicationRows();
  }
  const generation = applicationsScopeGeneration;
  let currentRequest: Promise<DemoApplicantRow[]> | null = null;
  try {
    currentRequest = (async () => {
      const url = opts?.selfScope ? "/api/manager-applications?scope=self" : "/api/manager-applications";
      const res = await fetch(url, { credentials: "include" });
      if (generation !== applicationsScopeGeneration) return [];
      notePortalResponse(res.status);
      if (res.status === 401 || res.status === 403) {
        clearQueuedApplicationIdentity();
        clearSensitiveApplicationCache();
        return [];
      }
      if (!res.ok) return readManagerApplicationRows();
      const body = (await res.json()) as { rows?: DemoApplicantRow[] };
      if (generation !== applicationsScopeGeneration) return [];
      // Union with the CURRENT cache, not `[]` — a locally-created row whose
      // upsert POST hasn't landed yet must survive this force refetch (see
      // `mergeApplicationRows`'s doc comment).
      const rows = mergeApplicationRows(memoryRows, Array.isArray(body.rows) ? body.rows : []);
      const changed = applicationRowsChanged(memoryRows, rows);
      memoryRows = rows;
      persistManagerApplicationsToSession(rows, managerUserId);
      managerApplicationsLastSyncedAt = Date.now();
      if (changed) emit();
      return rows;
    })().catch(() => generation === applicationsScopeGeneration ? readManagerApplicationRows() : []);
    managerApplicationsSyncPromise = currentRequest;
    return await currentRequest;
  } catch {
    return readManagerApplicationRows();
  } finally {
    if (managerApplicationsSyncPromise === currentRequest) managerApplicationsSyncPromise = null;
  }
}

export async function syncPublicApprovedApplicationsFromServer(opts?: { force?: boolean }): Promise<DemoApplicantRow[]> {
  if (!canUseStorage()) return [];
  // Demo sandbox is browser-local: never merge server rows into the seed.
  if (isDemoModeActive()) return readManagerApplicationRows();
  const generation = applicationsScopeGeneration;
  const force = opts?.force === true;
  if (!force && publicApprovedApplicationsSyncPromise) return publicApprovedApplicationsSyncPromise;
  if (!force && publicApprovedApplicationsLastSyncedAt > 0 && Date.now() - publicApprovedApplicationsLastSyncedAt < MANAGER_APPLICATIONS_SYNC_TTL_MS) {
    return readManagerApplicationRows();
  }
  try {
    publicApprovedApplicationsSyncPromise = (async () => {
      const res = await fetch("/api/public/approved-room-occupancy");
      if (generation !== applicationsScopeGeneration) return [];
      if (!res.ok) return readManagerApplicationRows();
      const body = (await res.json()) as { rows?: DemoApplicantRow[] };
      if (generation !== applicationsScopeGeneration) return [];
      const rows = mergeApplicationRows(memoryRows, Array.isArray(body.rows) ? body.rows : []);
      memoryRows = rows;
      publicApprovedApplicationsLastSyncedAt = Date.now();
      return rows;
    })().catch(() => readManagerApplicationRows());
    return await publicApprovedApplicationsSyncPromise;
  } catch {
    return readManagerApplicationRows();
  } finally {
    publicApprovedApplicationsSyncPromise = null;
  }
}

export function readManagerApplicationRows(fallback: DemoApplicantRow[] = EMPTY_FALLBACK): DemoApplicantRow[] {
  if (!isDemoModeActive() && activeApplicationsScopeUserId && portalSessionEnded()) {
    clearSensitiveApplicationCache();
    return [];
  }
  hydrateManagerApplicationsFromSession(activeApplicationsScopeUserId);
  const stored = normalizeApplicationRows(memoryRows);
  if (stored.length === 0) return [...fallback];
  return stored.map((r) => {
    const seed = fallback.find((f) => f.id === r.id);
    if (!seed) return r;
    return {
      ...seed,
      ...r,
      application: r.application ?? seed.application,
    };
  });
}

export function writeManagerApplicationRows(rows: DemoApplicantRow[]): void {
  try {
    const normalizedRows = normalizeApplicationRows(rows);
    if (!applicationRowsChanged(memoryRows, normalizedRows)) return;
    memoryRows = normalizedRows;
    persistManagerApplicationsToSession(normalizedRows, activeApplicationsScopeUserId);
    managerApplicationsLastSyncedAt = Date.now();
    emit();
    mirrorApplicationsToServer(normalizedRows);
    void import("@/lib/lease-pipeline-storage").then(({ syncLeasePipelineFromApplications }) => {
      syncLeasePipelineFromApplications(activeApplicationsScopeUserId ?? null);
    });
  } catch {
    /* ignore */
  }
}

/** Demo seed: load application rows into the local store without server mirror. */
export function seedDemoManagerApplicationRows(rows: DemoApplicantRow[], scopeUserId: string): void {
  if (!canUseStorage()) return;
  ensureApplicationsScope(scopeUserId);
  memoryRows = normalizeApplicationRows(rows);
  persistManagerApplicationsToSession(memoryRows, scopeUserId);
  managerApplicationsLastSyncedAt = Date.now();
  emit();
}

export function resetManagerApplicationRowsToDemo(): void {
  memoryRows = [];
  if (canUseStorage()) {
    window.sessionStorage.removeItem(managerApplicationsSessionKey(activeApplicationsScopeUserId));
  }
  emit();
}

/** Append one application (e.g. after resident submit). Skips if the same id already exists. */
/** Update one row in the in-memory / session cache after a successful server upsert. */
export function replaceManagerApplicationRowInCache(row: DemoApplicantRow): void {
  const normalizedRow = normalizeApplicationRow(row);
  const rows = readManagerApplicationRows();
  const idx = rows.findIndex((r) => r.id === normalizedRow.id);
  const next =
    idx >= 0 ? rows.map((r, i) => (i === idx ? normalizedRow : r)) : [...rows, normalizedRow];
  memoryRows = next;
  persistManagerApplicationsToSession(next, activeApplicationsScopeUserId);
  managerApplicationsLastSyncedAt = Date.now();
  emit();
}

export function appendManagerApplicationRow(
  row: DemoApplicantRow,
  opts?: { skipServerMirror?: boolean },
): void {
  const normalizedRow = normalizeApplicationRow(row);
  const rows = readManagerApplicationRows();
  if (rows.some((r) => r.id === normalizedRow.id)) return;
  const next = [...rows, normalizedRow];
  writeManagerApplicationRows(next);
  if (!opts?.skipServerMirror) mirrorApplicationRowToServer(normalizedRow);
}

/**
 * Returns the application answers with the manager's final property / room placement
 * applied on top of the original applicant submission.
 */
export function effectiveApplicationForRow(row: Pick<DemoApplicantRow, "application" | "assignedPropertyId" | "assignedRoomChoice" | "signedMonthlyRent" | "name" | "email">):
  | Partial<RentalWizardFormState>
  | undefined {
  if (!row.application) return undefined;
  const dates = resolvePlacementLeaseDates({
    leaseTerm: row.application.leaseTerm,
    leaseStart: row.application.leaseStart,
    leaseEnd: row.application.leaseEnd,
    rentalType: row.application.rentalType,
  });
  const personal = resolveApplicationPersonalFields(row);
  const next: Partial<RentalWizardFormState> = {
    ...row.application,
    ...personal,
    leaseTerm: dates.leaseTerm || row.application.leaseTerm,
    leaseStart: dates.leaseStart,
    leaseEnd: dates.leaseEnd,
  };
  const propertyId = row.assignedPropertyId?.trim();
  const roomChoice = row.assignedRoomChoice?.trim();
  if (propertyId) next.propertyId = propertyId;
  if (roomChoice) next.roomChoice1 = roomChoice;
  const signedRentLabel = signedRentLabelForRow(row);
  if (signedRentLabel) {
    (next as Partial<RentalWizardFormState> & { __signedRentLabel?: string }).__signedRentLabel = signedRentLabel;
  }
  return next;
}

export function signedRentLabelForRow(
  row: Pick<DemoApplicantRow, "signedMonthlyRent" | "application">,
): string | null {
  if (!Number.isFinite(row.signedMonthlyRent ?? NaN) || (row.signedMonthlyRent ?? 0) <= 0) return null;
  const amount = `$${Number(row.signedMonthlyRent).toFixed(2)}`;
  if (row.application?.rentalType === "short_term") return amount;
  return `${amount} / month`;
}

export { enrichApplicationForLease, resolveApplicationPersonalFields } from "@/lib/application-personal-fields";
