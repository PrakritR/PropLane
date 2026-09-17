import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { VendorCheckIn } from "@/lib/vendor-check-ins";
import type { VendorDocumentRecord } from "@/lib/vendor-documents";
import type { VendorChannel, VendorMessaging } from "@/lib/vendor-messaging";

export type ManagerVendorRow = {
  id: string;
  managerUserId: string | null;
  name: string;
  /** Legacy single-trade field, still set by the manager's Add/Edit vendor form. */
  trade: string;
  /** Vendor self-selected work capabilities (multi-select); falls back to [trade] when unset. */
  trades?: string[];
  phone: string;
  email: string;
  notes: string;
  active: boolean;
  propertyIds?: string[];
  /** When true, other managers on Axis can use this vendor for work orders. */
  sharedWithManagers?: boolean;
  /** Preferred vendor tier within the vendor's trade (one primary per trade on the account). */
  vendorPriority?: "primary" | "secondary";
  insuranceProvider?: string;
  insurancePolicyNumber?: string;
  /** ISO date (yyyy-mm-dd) the vendor's insurance coverage expires. */
  insuranceExpiresAt?: string;
  /** Uploaded compliance files (insurance cert, W-9 PDF, license). */
  vendorDocuments?: VendorDocumentRecord[];
  /** When true, vendor accepts bank transfer via Stripe Connect (link bank in Payments). */
  achPaymentsEnabled?: boolean;
  /** Derived snapshot of enabled payout methods (ACH only). */
  acceptedPaymentMethods?: "ach"[];
  /** Auth user id after the vendor accepts an invite and signs up. */
  vendorUserId?: string | null;
  /** Preferred language ("en" | "es") — pre-signup fallback; profiles.preferred_language is canonical once linked. */
  preferredLanguage?: string;
  /** What to call them in a message: "Jorge", not "Apex Plumbing LLC". */
  preferredName?: string;
  /** Where automatic messages go first; falls back sms → email → inapp (`resolveVendorChannel`). */
  preferredChannel?: VendorChannel;
  /** Per-event message templates and free-text instructions (`vendor-messaging.ts`). */
  messaging?: VendorMessaging;
  /** Recurring questions on a cadence, with their reply log (`vendor-check-ins.ts`). */
  checkIns?: VendorCheckIn[];
  /** PropLane catalog id when this roster row was copied from the marketplace. */
  catalogId?: string;
  /** Typical hourly + service $ per house × trade. */
  typicalRates?: ManagerVendorTypicalRate[];
  /** Sent-invite bookkeeping for the Invited pill: when the portal invite last went out. */
  invitedAt?: string;
  /** Synthetic settings row only — default vendor id per trade category. */
  categoryDefaults?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
};

export type ManagerVendorTypicalRate = {
  propertyId: string;
  trade: string;
  hourlyCents: number;
  serviceCents: number;
};

export const MANAGER_VENDORS_EVENT = "axis:manager-vendors";
const MANAGER_VENDOR_CATEGORY_SETTINGS_ID_PREFIX = "axis:vendor-category-settings";

export function managerVendorCategorySettingsRowId(managerUserId: string): string {
  return `${MANAGER_VENDOR_CATEGORY_SETTINGS_ID_PREFIX}_${managerUserId}`;
}

/** @deprecated Use managerVendorCategorySettingsRowId(managerUserId) — global id was cross-tenant unsafe. */
export const MANAGER_VENDOR_CATEGORY_SETTINGS_ROW_ID = "axis:vendor-category-settings";
const MANAGER_VENDORS_SESSION_KEY = "axis:manager-vendors:v1";

export type ManagerVendorCategorySettings = {
  defaultVendorIdByTrade: Record<string, string>;
};

export function isVendorCategorySettingsRow(row: Pick<ManagerVendorRow, "id" | "name">): boolean {
  return (
    row.name === "__vendor_category_settings__" ||
    row.id === MANAGER_VENDOR_CATEGORY_SETTINGS_ROW_ID ||
    row.id.startsWith(`${MANAGER_VENDOR_CATEGORY_SETTINGS_ID_PREFIX}_`)
  );
}

const EMPTY_FALLBACK: ManagerVendorRow[] = [];
let memoryRows: ManagerVendorRow[] = [];
const MANAGER_VENDORS_SYNC_TTL_MS = 15_000;
let managerVendorsLastSyncedAt = 0;
let managerVendorsSyncPromise: Promise<ManagerVendorRow[]> | null = null;

function vendorRowsChanged(a: ManagerVendorRow[], b: ManagerVendorRow[]) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function canUseStorage() {
  return typeof window !== "undefined";
}

function hydrateVendorsFromSession() {
  if (!canUseStorage() || memoryRows.length > 0) return;
  try {
    const raw = window.sessionStorage.getItem(MANAGER_VENDORS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as ManagerVendorRow[];
    if (Array.isArray(parsed)) memoryRows = parsed;
  } catch {
    /* ignore */
  }
}

function persistVendorsToSession(rows: ManagerVendorRow[]) {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.setItem(MANAGER_VENDORS_SESSION_KEY, JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

function emit() {
  if (!canUseStorage()) return;
  window.dispatchEvent(new Event(MANAGER_VENDORS_EVENT));
}

function ownVendorRows(rows: ManagerVendorRow[], managerUserId: string | null | undefined): ManagerVendorRow[] {
  if (!managerUserId) return rows;
  return rows.filter((r) => r.managerUserId === managerUserId || r.managerUserId == null);
}

function mirrorVendorsToServer(rows: ManagerVendorRow[], managerUserId?: string | null) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  const payload = managerUserId ? ownVendorRows(rows, managerUserId) : rows;
  void fetch("/api/portal-vendors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "replace", rows: payload }),
  }).catch(() => undefined);
}

function mirrorVendorRowToServer(row: ManagerVendorRow) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void persistManagerVendorToServer(row);
}

/** Await server persistence — use before routes that read `manager_vendor_records`. */
export async function persistManagerVendorToServer(row: ManagerVendorRow): Promise<boolean> {
  if (typeof window === "undefined" || isDemoModeActive()) return true;
  try {
    const res = await fetch("/api/portal-vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "upsert", row }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function deleteVendorFromServer(id: string) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/portal-vendors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "delete", id }),
  }).catch(() => undefined);
}

export function makeVendorId(): string {
  return `vendor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function syncManagerVendorsFromServer(opts?: { force?: boolean }): Promise<ManagerVendorRow[]> {
  if (!canUseStorage()) return [];
  hydrateVendorsFromSession();
  if (isDemoModeActive()) return readManagerVendorRows();
  const force = opts?.force === true;
  if (!force && managerVendorsSyncPromise) return managerVendorsSyncPromise;
  if (!force && managerVendorsLastSyncedAt > 0 && Date.now() - managerVendorsLastSyncedAt < MANAGER_VENDORS_SYNC_TTL_MS) {
    return readManagerVendorRows();
  }
  try {
    managerVendorsSyncPromise = (async () => {
      const res = await fetch("/api/portal-vendors", { credentials: "include" });
      if (!res.ok) return readManagerVendorRows();
      const body = (await res.json()) as { rows?: ManagerVendorRow[] };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const changed = vendorRowsChanged(memoryRows, rows);
      memoryRows = rows;
      persistVendorsToSession(rows);
      managerVendorsLastSyncedAt = Date.now();
      if (changed) emit();
      return rows;
    })();
    return await managerVendorsSyncPromise;
  } catch {
    return readManagerVendorRows();
  } finally {
    managerVendorsSyncPromise = null;
  }
}

export function readManagerVendorRows(fallback: ManagerVendorRow[] = EMPTY_FALLBACK): ManagerVendorRow[] {
  hydrateVendorsFromSession();
  if (memoryRows.length === 0) return [...fallback];
  return memoryRows;
}

/** Vendors owned by this manager account (excludes shared directory rows and settings row). */
export function readOwnManagerVendorRows(
  managerUserId: string | null | undefined,
  fallback: ManagerVendorRow[] = EMPTY_FALLBACK,
  opts?: {
    /** Owner manager ids whose directories this user co-manages (services module) —
     *  computed by the caller via collectLinkedOwnerIdsForModule (dependency-free here). */
    includeOwnerIds?: Set<string>;
  },
): ManagerVendorRow[] {
  if (!managerUserId) return [];
  const owners = opts?.includeOwnerIds;
  const rows = owners?.size
    ? readManagerVendorRows(fallback).filter(
        (r) => r.managerUserId === managerUserId || r.managerUserId == null || owners.has(r.managerUserId),
      )
    : ownVendorRows(readManagerVendorRows(fallback), managerUserId);
  return rows.filter((row) => !isVendorCategorySettingsRow(row));
}

export function readActiveManagerVendorRows(fallback: ManagerVendorRow[] = EMPTY_FALLBACK): ManagerVendorRow[] {
  return readManagerVendorRows(fallback).filter((v) => v.active !== false && !isVendorCategorySettingsRow(v));
}

export function readOwnActiveManagerVendorRows(
  managerUserId: string | null | undefined,
  fallback: ManagerVendorRow[] = EMPTY_FALLBACK,
): ManagerVendorRow[] {
  return readOwnManagerVendorRows(managerUserId, fallback).filter((v) => v.active !== false);
}

export function readManagerVendorCategorySettings(managerUserId?: string | null): ManagerVendorCategorySettings {
  const rows = readManagerVendorRows().filter((r) => isVendorCategorySettingsRow(r));
  const row = managerUserId
    ? rows.find((r) => r.managerUserId === managerUserId) ??
      rows.find((r) => r.id === managerVendorCategorySettingsRowId(managerUserId))
    : rows[0];
  return { defaultVendorIdByTrade: { ...(row?.categoryDefaults ?? {}) } };
}

export function saveManagerVendorCategorySettings(
  settings: ManagerVendorCategorySettings,
  managerUserId: string | null,
): void {
  if (!managerUserId) return;
  const now = new Date().toISOString();
  upsertManagerVendor(
    {
      id: managerVendorCategorySettingsRowId(managerUserId),
      managerUserId,
      name: "__vendor_category_settings__",
      trade: "",
      phone: "",
      email: "",
      notes: "",
      active: false,
      categoryDefaults: settings.defaultVendorIdByTrade,
      createdAt: now,
      updatedAt: now,
    },
    managerUserId,
  );
}

export function vendorsMatchingTrade(vendors: ManagerVendorRow[], trade: string): ManagerVendorRow[] {
  const needle = trade.trim().toLowerCase();
  if (!needle) return vendors;
  return vendors.filter((vendor) => {
    const trades = vendor.trades?.length ? vendor.trades : vendor.trade ? [vendor.trade] : [];
    return trades.some((t) => t.trim().toLowerCase() === needle) || vendor.trade.trim().toLowerCase() === needle;
  });
}

/** Demo seed: load vendor rows into the local store without server mirror. */
export function seedDemoManagerVendorRows(rows: ManagerVendorRow[]): void {
  if (!canUseStorage()) return;
  memoryRows = rows;
  persistVendorsToSession(rows);
  managerVendorsLastSyncedAt = Date.now();
  emit();
}

export function writeManagerVendorRows(rows: ManagerVendorRow[], managerUserId?: string | null): void {
  if (!vendorRowsChanged(memoryRows, rows)) return;
  memoryRows = rows;
  persistVendorsToSession(rows);
  managerVendorsLastSyncedAt = Date.now();
  emit();
  mirrorVendorsToServer(rows, managerUserId);
}

export function upsertManagerVendor(row: ManagerVendorRow, managerUserId?: string | null, options?: { persist?: boolean }): void {
  const rows = readManagerVendorRows();
  const idx = rows.findIndex((r) => r.id === row.id);
  const next = idx === -1 ? [...rows, row] : rows.map((r, i) => (i === idx ? row : r));
  if (options?.persist === false) {
    // Apply an already-authorized server write without issuing a second write or
    // replacing the entire directory from a stale client snapshot.
    memoryRows = next;
    persistVendorsToSession(next);
    managerVendorsLastSyncedAt = Date.now();
    emit();
    return;
  }
  writeManagerVendorRows(next, managerUserId ?? row.managerUserId);
  mirrorVendorRowToServer(row);
}

export function setManagerVendorActive(
  vendorId: string,
  active: boolean,
  managerUserId?: string | null,
): void {
  const rows = readManagerVendorRows();
  const target = rows.find((r) => r.id === vendorId);
  if (!target) return;
  upsertManagerVendor({ ...target, active, updatedAt: new Date().toISOString() }, managerUserId);
}

export function setManagerVendorPriority(
  vendorId: string,
  priority: ManagerVendorRow["vendorPriority"],
  managerUserId?: string | null,
): void {
  const rows = readManagerVendorRows();
  const target = rows.find((r) => r.id === vendorId);
  if (!target) return;
  const trade = target.trade.trim().toLowerCase();
  const now = new Date().toISOString();
  const next = rows.map((row) => {
    if (row.id === vendorId) {
      return { ...row, vendorPriority: priority, updatedAt: now };
    }
    if (
      priority === "primary" &&
      trade &&
      row.trade.trim().toLowerCase() === trade &&
      row.vendorPriority === "primary"
    ) {
      return { ...row, vendorPriority: undefined, updatedAt: now };
    }
    return row;
  });
  writeManagerVendorRows(next, managerUserId ?? target.managerUserId);
  const updated = next.find((r) => r.id === vendorId);
  if (updated) mirrorVendorRowToServer(updated);
}

export function deleteManagerVendorRow(id: string, managerUserId?: string | null): boolean {
  const rows = readManagerVendorRows();
  const target = rows.find((r) => r.id === id);
  if (!target) return false;
  if (managerUserId && target.managerUserId && target.managerUserId !== managerUserId) return false;
  writeManagerVendorRows(rows.filter((r) => r.id !== id), managerUserId);
  deleteVendorFromServer(id);
  return true;
}

export function filterOwnVendorRowsForSync(
  rows: ManagerVendorRow[],
  managerUserId: string | null | undefined,
): ManagerVendorRow[] {
  return ownVendorRows(rows, managerUserId);
}

export function subscribeManagerVendors(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MANAGER_VENDORS_EVENT, cb);
  return () => window.removeEventListener(MANAGER_VENDORS_EVENT, cb);
}
