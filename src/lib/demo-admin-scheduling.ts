import { isDemoModeActive } from "@/lib/demo/demo-session";
import { emitAdminUi } from "@/lib/demo-admin-ui";
import { logDemoOutboundEmail } from "@/lib/demo-outbound-mail";
import { notePortalResponse, portalSessionEnded } from "@/lib/auth/portal-session-gate";

const AVAIL_KEY = "axis_admin_avail_slots_v1";
/** Per calendar date (local `YYYY-MM-DD`) + half-hour slot — supports future weeks. */
export const ADMIN_AVAILABILITY_STORAGE_KEY = "axis_admin_avail_slots_v2";
const AVAIL_V2_KEY = ADMIN_AVAILABILITY_STORAGE_KEY;
const INQ_KEY = "axis_admin_partner_inquiries_v1";
const PLANNED_KEY = "axis_admin_planned_events_v1";
const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";
const PROP_MGR_REGISTRY_KEY = "axis_property_mgr_registry_v1";
const memoryStore = new Map<string, unknown>();
const SESSION_CACHE_PREFIX = "axis_sched_cache_v1:";
const SCHEDULE_SYNC_META_KEY = `${SESSION_CACHE_PREFIX}__synced_at`;
const SCHEDULE_SYNC_TTL_MS = 10_000;
let scheduleSyncPromise: Promise<boolean> | null = null;

/** A manager registered as available for tours at a property. */
export type PropertyManagerEntry = { userId: string; label: string; propertyId?: string };

type ManagerRegistry = Record<string, PropertyManagerEntry[]>;

function readManagerRegistry(): ManagerRegistry {
  return readJson<ManagerRegistry>(PROP_MGR_REGISTRY_KEY, {});
}

/** Register a manager as offering tours for a property (idempotent, updates label). */
export function registerManagerForProperty(userId: string, propertyId: string, label: string): void {
  if (!isBrowser() || !userId || !propertyId) return;
  const registry = readManagerRegistry();
  const existing = registry[propertyId] ?? [];
  const idx = existing.findIndex((e) => e.userId === userId);
  if (idx === -1) {
    registry[propertyId] = [...existing, { userId, label }];
  } else if (existing[idx]!.label !== label) {
    registry[propertyId] = existing.map((e, i) => (i === idx ? { userId, label } : e));
  } else {
    return;
  }
  writeJson(PROP_MGR_REGISTRY_KEY, registry);
}

/** All managers registered to offer tours for a property. */
export function getManagersForProperty(propertyId: string): PropertyManagerEntry[] {
  return readManagerRegistry()[propertyId] ?? [];
}

/** Monday = 0 … Sunday = 6 */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Half-hour slots across the full day (index 0 = 12:00–12:30 AM; last slot ends at midnight). */
export const SLOTS_PER_DAY = 48;

/** Minutes represented by one availability slot; also the default event length. */
export const SLOT_DURATION_MINUTES = 30;

/** Common event lengths offered when a manager schedules an event/tour. */
export const EVENT_DURATION_PRESET_MINUTES = [15, 30, 45, 60, 90] as const;

export const DEFAULT_EVENT_DURATION_MINUTES = SLOT_DURATION_MINUTES;
export const MIN_EVENT_DURATION_MINUTES = 5;
export const MAX_EVENT_DURATION_MINUTES = 480;

/** Coerce arbitrary input to a usable event duration (whole minutes, sane bounds). */
export function clampEventDurationMinutes(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_EVENT_DURATION_MINUTES;
  return Math.min(MAX_EVENT_DURATION_MINUTES, Math.max(MIN_EVENT_DURATION_MINUTES, Math.round(raw)));
}

/** Whole-minute length of an ISO window; defaults to 30 min for missing/invalid ranges. */
export function durationMinutesBetweenIso(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return DEFAULT_EVENT_DURATION_MINUTES;
  return Math.max(1, Math.round((end - start) / 60_000));
}

/** End ISO for a start plus a chosen duration (clamped); falls back to the start on bad input. */
export function endIsoForDuration(startIso: string, durationMinutes: number): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return startIso;
  return new Date(start.getTime() + clampEventDurationMinutes(durationMinutes) * 60_000).toISOString();
}

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

function readScheduleSyncedAt(): number {
  if (!isBrowser()) return 0;
  try {
    const raw = window.sessionStorage.getItem(SCHEDULE_SYNC_META_KEY);
    const parsed = Number(raw ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeScheduleSyncedAt(value: number) {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(SCHEDULE_SYNC_META_KEY, String(value));
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

function scheduleRecordScope(key: string): { managerUserId: string | null; propertyId: string | null; recordType: string } {
  if (key === AVAIL_V2_KEY) {
    return { managerUserId: null, propertyId: null, recordType: "admin_availability" };
  }
  const adminScoped = key.match(/^axis_admin_avail_slots_v2_admin_(.+)$/);
  if (adminScoped) {
    return {
      managerUserId: adminScoped[1] ?? null,
      propertyId: null,
      recordType: "admin_availability",
    };
  }
  const propertyScoped = key.match(/^axis_mgr_avail_slots_v2_(.+)_prop_(.+)$/);
  if (propertyScoped) {
    return {
      managerUserId: propertyScoped[1] ?? null,
      propertyId: propertyScoped[2] ?? null,
      recordType: "manager_property_availability",
    };
  }
  const shareScoped = key.match(/^axis_calendar_share_avail_(.+)_prop_(.+)$/);
  if (shareScoped) {
    return {
      managerUserId: shareScoped[1] ?? null,
      propertyId: shareScoped[2] ?? null,
      recordType: "calendar_share_settings",
    };
  }
  const managerScoped = key.match(/^axis_mgr_avail_slots_v2_(.+)$/);
  if (managerScoped) {
    return {
      managerUserId: managerScoped[1] ?? null,
      propertyId: null,
      recordType: "manager_availability",
    };
  }
  const vendorAvail = key.match(/^axis_vendor_avail_slots_v2_(.+)$/);
  if (vendorAvail) {
    return {
      managerUserId: vendorAvail[1] ?? null,
      propertyId: null,
      recordType: "vendor_availability",
    };
  }
  const vendorPrefs = key.match(/^axis_vendor_flex_prefs_(.+)$/);
  if (vendorPrefs) {
    return {
      managerUserId: vendorPrefs[1] ?? null,
      propertyId: null,
      recordType: "vendor_flexible_preferences",
    };
  }
  return { managerUserId: null, propertyId: null, recordType: key };
}

function writeJson(key: string, value: unknown) {
  if (!isBrowser()) return;
  memoryStore.set(key, value);
  writeSessionJson(key, value);
  emitAdminUi();
  void writeJsonToServer(key, value).catch(() => undefined);
}

async function persistPublicPartnerInquiry(
  row: PartnerInquiry,
): Promise<{ ok: boolean; row?: PartnerInquiry; error?: string }> {
  if (!isBrowser()) return { ok: false, error: "Browser required." };
  const res = await fetch("/api/public/partner-inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ row }),
  });
  if (res.ok) {
    try {
      const body = (await res.json()) as { row?: PartnerInquiry };
      if (body.row?.id) return { ok: true, row: body.row };
    } catch {
      // Fall back to the client-built row when the response is not JSON.
    }
    return { ok: true, row };
  }
  let error = "Could not save inquiry.";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) error = body.error;
  } catch {
    // Keep the generic message when the response is not JSON.
  }
  return { ok: false, error };
}

async function writeJsonToServer(key: string, value: unknown): Promise<boolean> {
  if (!isBrowser()) return false;
  const scope = scheduleRecordScope(key);
  const res = await fetch("/api/portal-schedule-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      action: "upsert",
      row: {
        id: key,
        recordType: scope.recordType,
        managerUserId: scope.managerUserId,
        propertyId: scope.propertyId,
        adminLabel: typeof memoryStore.get(`${key}:adminLabel`) === "string" ? memoryStore.get(`${key}:adminLabel`) : undefined,
        payload: value,
      },
    }),
  });
  return res.ok;
}

async function deleteJsonRecordFromServer(id: string): Promise<boolean> {
  if (!isBrowser()) return false;
  const res = await fetch("/api/portal-schedule-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "delete", id }),
  });
  return res.ok;
}

export async function syncScheduleRecordsFromServer(opts?: { force?: boolean }): Promise<boolean> {
  if (!isBrowser()) return false;
  if (isDemoModeActive()) return true;
  // Signed out: stop the interval-driven refetch instead of 401ing forever.
  if (portalSessionEnded()) return false;
  const force = opts?.force === true;
  const lastSyncedAt = readScheduleSyncedAt();
  if (!force && scheduleSyncPromise) {
    try {
      return await scheduleSyncPromise;
    } catch {
      return false;
    }
  }
  if (!force && lastSyncedAt > 0 && Date.now() - lastSyncedAt < SCHEDULE_SYNC_TTL_MS) {
    return true;
  }
  try {
    scheduleSyncPromise = (async () => {
      try {
        const res = await fetch("/api/portal-schedule-records", {
          cache: "no-store",
          credentials: "include",
        });
        notePortalResponse(res.status);
        if (!res.ok) return false;
        const body = (await res.json()) as { rows?: unknown[] };
        if (!Array.isArray(body.rows)) return false;
        const standaloneInquiries: PartnerInquiry[] = [];
        for (const raw of body.rows) {
          if (!raw || typeof raw !== "object") continue;
          const row = raw as { id?: unknown; payload?: unknown; recordType?: unknown };
          if (typeof row.id !== "string") continue;
          if (row.recordType === "partner_inquiry_request" && row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)) {
            standaloneInquiries.push(row.payload as PartnerInquiry);
          }
          memoryStore.set(row.id, Array.isArray(row.payload) || row.payload !== undefined ? row.payload : []);
          writeSessionJson(row.id, Array.isArray(row.payload) || row.payload !== undefined ? row.payload : []);
        }
        if (standaloneInquiries.length > 0) {
          const existing = readJson<PartnerInquiry[]>(INQ_KEY, []);
          const byId = new Map(existing.map((row) => [row.id, row]));
          for (const row of standaloneInquiries) {
            if (typeof row.id === "string" && !byId.has(row.id)) byId.set(row.id, row);
          }
          const merged = [...byId.values()];
          memoryStore.set(INQ_KEY, merged);
          writeSessionJson(INQ_KEY, merged);
        }
        writeScheduleSyncedAt(Date.now());
        emitAdminUi();
        void import("@/lib/manager-tasks").then((mod) => mod.reapplyAllManagerTasksToCalendar());
        return true;
      } catch {
        return false;
      }
    })().catch(() => false);
    return await scheduleSyncPromise;
  } catch {
    return false;
  } finally {
    scheduleSyncPromise = null;
  }
}

export function slotKey(dayIndex: number, slotIndex: number) {
  return `${dayIndex}-${slotIndex}`;
}

export function toLocalDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dateSlotKey(dateStr: string, slotIndex: number) {
  return `${dateStr}:${slotIndex}`;
}

export function startOfWeekMonday(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const dow = mondayBasedDayIndex(x);
  x.setDate(x.getDate() - dow);
  return x;
}

export function parseSlotKey(key: string): { dayIndex: number; slotIndex: number } | null {
  const [a, b] = key.split("-");
  const dayIndex = Number.parseInt(a ?? "", 10);
  const slotIndex = Number.parseInt(b ?? "", 10);
  if (!Number.isFinite(dayIndex) || !Number.isFinite(slotIndex)) return null;
  if (dayIndex < 0 || dayIndex > 6 || slotIndex < 0 || slotIndex >= SLOTS_PER_DAY) return null;
  return { dayIndex, slotIndex };
}

export function readAvailabilitySet(): Set<string> {
  const arr = readJson<string[] | null>(AVAIL_KEY, null);
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr);
}

export function writeAvailabilitySet(next: Set<string>) {
  writeJson(AVAIL_KEY, [...next]);
}

/** Date-specific availability (`YYYY-MM-DD:slotIndex`). Migrates legacy weekly v1 into the current week when v2 is unset. */
export function readAvailabilityDateSet(): Set<string> {
  const arr = readJson<string[]>(AVAIL_V2_KEY, []);
  return Array.isArray(arr) ? new Set(arr) : new Set();
}

export function writeAvailabilityDateSet(next: Set<string>) {
  writeJson(AVAIL_V2_KEY, [...next]);
}

/** Manager calendar availability — separate from admin (`AVAIL_V2_KEY`). Portfolio default when no property selected. */
export function managerAvailabilityStorageKey(userId: string): string {
  return `axis_mgr_avail_slots_v2_${userId}`;
}

/** Per-property tour availability (manager calendar) — scoped to a demo property / house row id. */
export function managerPropertyAvailabilityStorageKey(userId: string, propertyId: string): string {
  const safe = propertyId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return `axis_mgr_avail_slots_v2_${userId}_prop_${safe}`;
}

/** Vendor calendar availability — drag-created open slots for work order visits. */
export function vendorAvailabilityStorageKey(userId: string): string {
  return `axis_vendor_avail_slots_v2_${userId}`;
}

/** Vendor flexible scheduling preferences (morning/afternoon/evening rank). */
export function vendorFlexiblePreferencesStorageKey(userId: string): string {
  return `axis_vendor_flex_prefs_${userId}`;
}

/** Per-property opt-in for co-managers to see this manager's tour availability. */
export function calendarShareAvailabilityStorageKey(userId: string, propertyId: string): string {
  const safe = propertyId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return `axis_calendar_share_avail_${userId}_prop_${safe}`;
}

export function readCalendarShareAvailability(userId: string, propertyId: string): boolean {
  if (!isBrowser() || !userId.trim() || !propertyId.trim()) return false;
  const key = calendarShareAvailabilityStorageKey(userId, propertyId);
  const raw = readJson<{ shareAvailability?: boolean } | null>(key, null);
  return raw?.shareAvailability === true;
}

export function writeCalendarShareAvailability(userId: string, propertyId: string, share: boolean): void {
  if (!isBrowser() || !userId.trim() || !propertyId.trim()) return;
  const key = calendarShareAvailabilityStorageKey(userId, propertyId);
  writeJson(key, { shareAvailability: share });
}

/** Per-admin partner meeting availability. Legacy ADMIN_AVAILABILITY_STORAGE_KEY is still read as a shared fallback. */
export function adminAvailabilityStorageKey(userId: string): string {
  return `axis_admin_avail_slots_v2_admin_${userId}`;
}

/** Read/write availability for an arbitrary storage key (admin v2 or manager-scoped). */
export function readAvailabilityDateSetForStorageKey(storageKey: string): Set<string> {
  if (storageKey === AVAIL_V2_KEY) return readAvailabilityDateSet();
  const arr = readJson<string[]>(storageKey, []);
  return Array.isArray(arr) ? new Set(arr) : new Set();
}

export function writeAvailabilityDateSetForStorageKey(next: Set<string>, storageKey: string, metadata?: { adminLabel?: string | null }) {
  if (storageKey === AVAIL_V2_KEY) {
    writeAvailabilityDateSet(next);
    return;
  }
  if (metadata?.adminLabel?.trim()) {
    memoryStore.set(`${storageKey}:adminLabel`, metadata.adminLabel.trim());
  }
  writeJson(storageKey, [...next]);
}

export async function writeAvailabilityDateSetForStorageKeyToServer(
  next: Set<string>,
  storageKey: string,
  metadata?: { adminLabel?: string | null },
): Promise<boolean> {
  if (metadata?.adminLabel?.trim()) {
    memoryStore.set(`${storageKey}:adminLabel`, metadata.adminLabel.trim());
  }
  memoryStore.set(storageKey, [...next]);
  emitAdminUi();
  return writeJsonToServer(storageKey, [...next]);
}

export function dateHasAvailability(d: Date, availability: Set<string>) {
  const ds = toLocalDateStr(d);
  for (let s = 0; s < SLOTS_PER_DAY; s += 1) {
    if (availability.has(dateSlotKey(ds, s))) return true;
  }
  return false;
}

export function dateStrFromCalendar(calYear: number, calMonth: number, day: number) {
  return toLocalDateStr(new Date(calYear, calMonth, day, 12, 0, 0, 0));
}

export function getOpenSlotIndicesForDateStr(dateStr: string) {
  const set = readAvailabilityDateSet();
  const out: number[] = [];
  for (let i = 0; i < SLOTS_PER_DAY; i += 1) {
    if (set.has(dateSlotKey(dateStr, i))) out.push(i);
  }
  return out;
}

export function dateHasOpenSlots(dateStr: string) {
  return getOpenSlotIndicesForDateStr(dateStr).length > 0;
}

export function formatAvailabilitySlotLabel(slotIndex: number) {
  const mins = slotIndex * 30;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "am" : "pm";
  if (m === 0) return `${h12} ${ampm}`;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Local start time for a painted half-hour on a calendar date (midnight + slotIndex×30 min). */
export function localDateAtSlotStart(dateStr: string, slotIndex: number) {
  const [y, mo, day] = dateStr.split("-").map(Number);
  const base = new Date(y!, mo! - 1, day!, 0, 0, 0, 0);
  base.setMinutes(base.getMinutes() + slotIndex * 30);
  return base;
}

export function isCalendarDayBeforeToday(calYear: number, calMonth: number, day: number) {
  const cell = new Date(calYear, calMonth, day, 0, 0, 0, 0);
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  return cell < t0;
}

export function mondayBasedDayIndex(d: Date) {
  return (d.getDay() + 6) % 7;
}

export function slotIndexForDate(d: Date) {
  const h = d.getHours();
  const m = d.getMinutes();
  const base = h * 2 + (m >= 30 ? 1 : 0);
  if (base < 0 || base >= SLOTS_PER_DAY) return null;
  return base;
}

/** True when the start time falls in a painted availability half-hour cell (date-specific v2). */
export function isStartInsideAvailability(isoStart: string): boolean {
  const t = new Date(isoStart);
  if (Number.isNaN(t.getTime())) return false;
  const ds = toLocalDateStr(t);
  const slot = slotIndexForDate(t);
  if (slot == null) return false;
  const set = readAvailabilityDateSet();
  return set.has(dateSlotKey(ds, slot));
}

export type PartnerInquiryStatus = "pending" | "accepted" | "declined";

export type PartnerInquiryWindow = {
  start: string;
  end: string;
  adminUserId?: string;
  adminLabel?: string;
  slotKey?: string;
};

export type PartnerInquiry = {
  id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  /** Explicit A2P/CTIA SMS opt-in captured on the tours-contact form. */
  smsConsent?: boolean;
  /** ISO timestamp of the opt-in decision, for provable consent later. */
  smsConsentAt?: string;
  kind?: "partner" | "tour";
  managerUserId?: string;
  tourGroupId?: string;
  propertyId?: string;
  propertyTitle?: string;
  roomLabel?: string;
  adminUserId?: string;
  adminLabel?: string;
  requestedWindows?: PartnerInquiryWindow[];
  proposedStart: string;
  proposedEnd: string;
  status: PartnerInquiryStatus;
  createdAt: string;
};

export type PlannedEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  sourceInquiryId?: string;
  sourceTaskId?: string;
  kind?: "partner" | "tour" | "task";
  managerUserId?: string;
  tourGroupId?: string;
  propertyId?: string;
  propertyTitle?: string;
  roomLabel?: string;
  adminUserId?: string;
  adminLabel?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  notes?: string;
  /** Shown in admin details; emailed to partner when accepted (demo log). */
  instructions?: string;
  slotKey?: string;
  /** Google Calendar event id after PropPlane sync. */
  googleCalendarEventId?: string;
  /** Set when a confirmed tour is cancelled — kept for Past list history. */
  canceledAt?: string | null;
  assignee?: import("@/lib/work-assignment").WorkAssignee;
};

export function isActivePlannedEvent(event: PlannedEvent): boolean {
  return !String(event.canceledAt ?? "").trim();
}

export function readPartnerInquiries(): PartnerInquiry[] {
  const rows = readJson<PartnerInquiry[] | null>(INQ_KEY, null);
  return Array.isArray(rows) ? rows : [];
}

function isFutureOrCurrentIsoWindow(iso: string): boolean {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return false;
  return when.getTime() >= Date.now() - 30 * 60 * 1000;
}

export function appendPartnerInquiry(payload: Omit<PartnerInquiry, "id" | "status" | "createdAt">) {
  const row = buildPartnerInquiry(payload);
  insertPartnerInquiryLocally(row);
  void persistPublicPartnerInquiry(row).catch(() => undefined);
  return row;
}

export async function appendPartnerInquiryToServer(
  payload: Omit<PartnerInquiry, "id" | "status" | "createdAt">,
): Promise<{ ok: boolean; row?: PartnerInquiry; error?: string }> {
  const row = buildPartnerInquiry(payload);
  const result = await persistPublicPartnerInquiry(row);
  if (!result.ok) return { ok: false, error: result.error };
  const persistedRow = result.row ?? row;
  insertPartnerInquiryLocally(persistedRow);
  return { ok: true, row: persistedRow };
}

export function updatePartnerInquiry(id: string, patch: Partial<PartnerInquiry>) {
  const rows = readPartnerInquiries();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  const next = [...rows];
  const merged = { ...next[idx]!, ...patch };
  const normalizedWindows = normalizePartnerInquiryWindows(merged);
  next[idx] = {
    ...merged,
    requestedWindows: normalizedWindows,
    proposedStart: normalizedWindows[0]?.start ?? merged.proposedStart,
    proposedEnd: normalizedWindows[0]?.end ?? merged.proposedEnd,
  };
  writeJson(INQ_KEY, next);
  return true;
}

export function readPlannedEvents(): PlannedEvent[] {
  const rows = readJson<PlannedEvent[] | null>(PLANNED_KEY, null);
  return Array.isArray(rows)
    ? rows.filter(
        (row) => isActivePlannedEvent(row) && isFutureOrCurrentIsoWindow(row.end || row.start),
      )
    : [];
}

/** Full planned-event history — list views need past tours the week grid omits. */
export function readAllPlannedEvents(): PlannedEvent[] {
  return readPlannedEventsRaw();
}

function readPlannedEventsRaw(): PlannedEvent[] {
  const rows = readJson<PlannedEvent[] | null>(PLANNED_KEY, null);
  return Array.isArray(rows) ? rows : [];
}

/** Replace this manager's task blocks on the shared planned-events calendar. */
export function replaceManagerTaskPlannedEvents(managerUserId: string, taskEvents: PlannedEvent[]): void {
  if (!isBrowser()) return;
  const next = readPlannedEventsRaw().filter(
    (event) => !(event.kind === "task" && event.managerUserId === managerUserId),
  );
  next.push(...taskEvents);
  writeJson(PLANNED_KEY, next);
}

function appendPlannedEvent(ev: PlannedEvent) {
  const rows = readPlannedEvents();
  rows.push(ev);
  writeJson(PLANNED_KEY, rows);
}

export function deletePlannedEvent(id: string): boolean {
  const rows = readPlannedEvents();
  const next = rows.filter((e) => e.id !== id);
  if (next.length === rows.length) return false;
  writeJson(PLANNED_KEY, next);
  return true;
}

export async function deletePlannedEventFromServer(id: string): Promise<boolean> {
  if (!deletePlannedEvent(id)) return false;
  return writeJsonToServer(PLANNED_KEY, readPlannedEvents());
}

/** Manager-entered tour that skips the public inquiry flow. */
export function appendManualPlannedTourLocal(
  managerUserId: string,
  input: {
    propertyId: string;
    propertyTitle?: string;
    roomLabel?: string;
    guestName: string;
    guestEmail?: string;
    guestPhone?: string;
    start: string;
    end: string;
    notes?: string;
    assignee?: import("@/lib/work-assignment").WorkAssignee;
  },
): PlannedEvent {
  const guestName = input.guestName.trim();
  const event: PlannedEvent = {
    id: crypto.randomUUID(),
    title: `Tour · ${guestName || "Guest"}`,
    start: input.start,
    end: input.end,
    kind: "tour",
    managerUserId,
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle,
    roomLabel: input.roomLabel,
    adminUserId: managerUserId,
    attendeeName: guestName || undefined,
    attendeeEmail: input.guestEmail?.trim() || undefined,
    attendeePhone: input.guestPhone?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    assignee: input.assignee,
  };
  const rows = readPlannedEventsRaw();
  rows.push(event);
  writeJson(PLANNED_KEY, rows);
  return event;
}

/**
 * Demo seed: load calendar data (confirmed events, pending tour requests, and
 * per-storage-key availability slot sets) into the local store without the
 * server mirror. Full overwrite per key, matching the other `seedDemo…` helpers.
 */
export function seedDemoScheduleData(input: {
  plannedEvents?: PlannedEvent[];
  partnerInquiries?: PartnerInquiry[];
  availabilityByStorageKey?: Record<string, string[]>;
}): void {
  if (!isBrowser()) return;
  if (input.plannedEvents) {
    memoryStore.set(PLANNED_KEY, input.plannedEvents);
    writeSessionJson(PLANNED_KEY, input.plannedEvents);
  }
  if (input.partnerInquiries) {
    memoryStore.set(INQ_KEY, input.partnerInquiries);
    writeSessionJson(INQ_KEY, input.partnerInquiries);
  }
  for (const [key, slots] of Object.entries(input.availabilityByStorageKey ?? {})) {
    memoryStore.set(key, slots);
    writeSessionJson(key, slots);
  }
  emitAdminUi();
}

export function pendingInquiryCount() {
  return readPartnerInquiries().filter((r) => {
    if (r.status !== "pending") return false;
    if (r.kind === "tour") return false;
    const windows = getPartnerInquiryWindows(r);
    if (windows.length > 0) {
      return windows.some((window) => isFutureOrCurrentIsoWindow(window.end || window.start));
    }
    return isFutureOrCurrentIsoWindow(r.proposedEnd || r.proposedStart);
  }).length;
}

export function acceptPartnerInquiry(id: string, opts?: { instructions?: string; start?: string; end?: string }): boolean {
  const rows = readPartnerInquiries();
  const row = rows.find((r) => r.id === id);
  if (!row || row.status !== "pending") return false;
  const instructions = opts?.instructions?.trim() || undefined;
  const start = opts?.start ?? row.proposedStart;
  const end = opts?.end ?? row.proposedEnd;
  const windows = getPartnerInquiryWindows(row);
  // A custom duration changes the end, so fall back to matching the window by start alone.
  const selectedWindow =
    windows.find((window) => window.start === start && window.end === end) ??
    windows.find((window) => window.start === start);
  updatePartnerInquiry(id, { status: "accepted" });
  appendPlannedEvent({
    id: crypto.randomUUID(),
    title: row.kind === "tour" ? `Tour · ${row.name}` : `Partner call · ${row.name}`,
    start,
    end,
    sourceInquiryId: id,
    kind: row.kind,
    managerUserId: row.managerUserId,
    tourGroupId: row.tourGroupId,
    propertyId: row.propertyId,
    propertyTitle: row.propertyTitle,
    roomLabel: row.roomLabel,
    adminUserId: selectedWindow?.adminUserId ?? row.adminUserId,
    adminLabel: selectedWindow?.adminLabel ?? row.adminLabel,
    attendeeName: row.name,
    attendeeEmail: row.email,
    attendeePhone: row.phone,
    notes: row.notes,
    instructions,
    slotKey: selectedWindow?.slotKey,
  });
  const when = formatRangeLabel(start, end);
  const extra = instructions ? `\n\nDetails from the host:\n${instructions}` : "";
  logDemoOutboundEmail(
    row.email,
    row.kind === "tour" ? "Your PropLane tour is scheduled" : "Your PropLane partner meeting is scheduled",
    `Hi ${row.name},\n\nYour ${row.kind === "tour" ? "tour" : "meeting"} is confirmed for:\n${when}.${extra}\n\n— PropLane (outbound mail is logged for review).`,
  );
  return true;
}

function partnerInquiryEventRecordIds(row: PartnerInquiry): string[] {
  return getPartnerInquiryWindows(row).map((_, index) => `${INQUIRY_EVENT_RECORD_TYPE}_${row.id}_${index}`);
}

async function deletePartnerInquiryEventRecords(row: PartnerInquiry): Promise<boolean> {
  const results = await Promise.all(partnerInquiryEventRecordIds(row).map((id) => deleteJsonRecordFromServer(id)));
  return results.every(Boolean);
}

export async function acceptPartnerInquiryFromServer(
  id: string,
  opts?: {
    instructions?: string;
    start?: string;
    end?: string;
    notifyTenant?: boolean;
    subject?: string;
    body?: string;
    assignee?: import("@/lib/work-assignment").WorkAssignee | null;
  },
): Promise<{ ok: boolean; error?: string; notificationSkipped?: boolean }> {
  const row = readPartnerInquiries().find((r) => r.id === id);
  if (row?.kind === "tour") {
    const res = await fetch("/api/portal-tour-inquiries/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        id,
        start: opts?.start ?? row.proposedStart,
        end: opts?.end ?? row.proposedEnd,
        instructions: opts?.instructions,
        notifyTenant: opts?.notifyTenant === true,
        subject: opts?.subject,
        body: opts?.body,
        assignee: opts?.assignee ?? undefined,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      tenantNotification?: { ok?: boolean; skipped?: boolean; error?: string };
    };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? "Could not approve tour request." };
    }
    await syncScheduleRecordsFromServer({ force: true });
    return {
      ok: true,
      notificationSkipped: data.tenantNotification?.skipped === true,
      error: data.tenantNotification?.error,
    };
  }
  if (!row || !acceptPartnerInquiry(id, opts)) return { ok: false, error: "Could not approve request." };
  const [inquiriesOk, plannedOk, eventRecordsOk] = await Promise.all([
    writeJsonToServer(INQ_KEY, readPartnerInquiries()),
    writeJsonToServer(PLANNED_KEY, readPlannedEvents()),
    deletePartnerInquiryEventRecords(row),
  ]);
  return inquiriesOk && plannedOk && eventRecordsOk ? { ok: true } : { ok: false, error: "Could not sync approval." };
}

export function declinePartnerInquiry(id: string) {
  return updatePartnerInquiry(id, { status: "declined" });
}

export function deletePartnerInquiry(id: string): boolean {
  const rows = readPartnerInquiries();
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) return false;
  writeJson(INQ_KEY, next);
  return true;
}

function tourInquiryMatchesSlot(row: PartnerInquiry, target: PartnerInquiry): boolean {
  if (row.kind !== "tour" || target.kind !== "tour") return false;
  const targetWindows = getPartnerInquiryWindows(target);
  if (targetWindows.length === 0) return row.id === target.id;
  return getPartnerInquiryWindows(row).some((window) =>
    targetWindows.some(
      (targetWindow) =>
        (row.managerUserId || window.adminUserId) === (target.managerUserId || targetWindow.adminUserId) &&
        window.start === targetWindow.start &&
        window.end === targetWindow.end,
    ),
  );
}

function deletePartnerInquiryLocally(row: PartnerInquiry): boolean {
  const rows = readPartnerInquiries();
  const next = rows.filter((candidate) => candidate.id !== row.id && !tourInquiryMatchesSlot(candidate, row));
  if (next.length === rows.length) return false;
  writeJson(INQ_KEY, next);
  return true;
}

async function deleteTourInquiryFromServer(
  row: PartnerInquiry,
  opts?: { notifyTenant?: boolean; subject?: string; body?: string },
): Promise<boolean> {
  const selectedWindow = getPartnerInquiryWindows(row)[0];
  const res = await fetch("/api/portal-tour-inquiries/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      id: row.id,
      managerUserId: row.managerUserId ?? selectedWindow?.adminUserId,
      start: selectedWindow?.start ?? row.proposedStart,
      end: selectedWindow?.end ?? row.proposedEnd,
      notifyTenant: opts?.notifyTenant !== false,
      subject: opts?.subject,
      body: opts?.body,
    }),
  });
  return res.ok;
}

export async function deletePartnerInquiryFromServer(
  id: string,
  opts?: { notifyTenant?: boolean; subject?: string; body?: string },
): Promise<boolean> {
  const row = readPartnerInquiries().find((r) => r.id === id);
  if (!row) return false;
  if (row.kind === "tour") {
    if (!(await deleteTourInquiryFromServer(row, opts))) return false;
    await syncScheduleRecordsFromServer({ force: true });
    return true;
  }
  if (!deletePartnerInquiryLocally(row)) return false;
  const [inquiriesOk, eventRecordsOk] = await Promise.all([
    writeJsonToServer(INQ_KEY, readPartnerInquiries()),
    deletePartnerInquiryEventRecords(row),
  ]);
  return inquiriesOk && eventRecordsOk;
}

export function getPartnerInquiryWindows(row: PartnerInquiry): PartnerInquiryWindow[] {
  return normalizePartnerInquiryWindows(row);
}

export function formatPartnerInquiryWindowsLabel(row: PartnerInquiry) {
  const windows = getPartnerInquiryWindows(row);
  if (windows.length === 0) return "—";
  if (windows.length === 1) {
    return formatRangeLabel(windows[0]!.start, windows[0]!.end);
  }
  return `${windows.length} requested windows`;
}

export function formatRangeLabel(isoStart: string, isoEnd: string) {
  try {
    const a = new Date(isoStart);
    const b = new Date(isoEnd);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "—";
    const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    return `${a.toLocaleString(undefined, opts)} – ${b.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  } catch {
    return "—";
  }
}

function buildPartnerInquiry(payload: Omit<PartnerInquiry, "id" | "status" | "createdAt">): PartnerInquiry {
  const normalizedWindows = normalizePartnerInquiryWindows(payload);
  return {
    ...payload,
    requestedWindows: normalizedWindows,
    proposedStart: normalizedWindows[0]?.start ?? payload.proposedStart,
    proposedEnd: normalizedWindows[0]?.end ?? payload.proposedEnd,
    adminUserId: payload.adminUserId ?? normalizedWindows[0]?.adminUserId,
    adminLabel: payload.adminLabel ?? normalizedWindows[0]?.adminLabel,
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

function insertPartnerInquiryLocally(row: PartnerInquiry) {
  const rows = readPartnerInquiries();
  rows.unshift(row);
  writeJson(INQ_KEY, rows);
}

function normalizePartnerInquiryWindows(row: Pick<PartnerInquiry, "requestedWindows" | "proposedStart" | "proposedEnd" | "adminUserId" | "adminLabel">): PartnerInquiryWindow[] {
  const requested = Array.isArray(row.requestedWindows)
    ? row.requestedWindows
        .filter(
          (window) =>
            typeof window?.start === "string" &&
            typeof window?.end === "string" &&
            !Number.isNaN(new Date(window.start).getTime()) &&
            !Number.isNaN(new Date(window.end).getTime()),
        )
        .map((window) => ({
          start: window.start,
          end: window.end,
          adminUserId: typeof window.adminUserId === "string" ? window.adminUserId : undefined,
          adminLabel: typeof window.adminLabel === "string" ? window.adminLabel : undefined,
          slotKey: typeof window.slotKey === "string" ? window.slotKey : undefined,
        }))
    : [];

  if (requested.length > 0) {
    return requested.sort((a, b) => a.start.localeCompare(b.start));
  }

  if (
    typeof row.proposedStart === "string" &&
    typeof row.proposedEnd === "string" &&
    !Number.isNaN(new Date(row.proposedStart).getTime()) &&
    !Number.isNaN(new Date(row.proposedEnd).getTime())
  ) {
    return [{
      start: row.proposedStart,
      end: row.proposedEnd,
      adminUserId: typeof row.adminUserId === "string" ? row.adminUserId : undefined,
      adminLabel: typeof row.adminLabel === "string" ? row.adminLabel : undefined,
    }];
  }

  return [];
}
