import { DEMO_VENDOR_NAME, isDemoModeActive } from "@/lib/demo/demo-session";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { removePendingWorkOrderChargesForWorkOrder } from "@/lib/household-charges";

export const MANAGER_WORK_ORDERS_EVENT = "axis:manager-work-orders";
const MANAGER_WORK_ORDERS_SESSION_KEY = "axis:manager-work-orders:v1";

const EMPTY_FALLBACK: DemoManagerWorkOrderRow[] = [];
let memoryRows: DemoManagerWorkOrderRow[] = [];
const MANAGER_WORK_ORDERS_SYNC_TTL_MS = 15_000;
let managerWorkOrdersLastSyncedAt = 0;
let managerWorkOrdersSyncPromise: Promise<DemoManagerWorkOrderRow[]> | null = null;

function workOrderRowsChanged(a: DemoManagerWorkOrderRow[], b: DemoManagerWorkOrderRow[]) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Stable snapshot for SSR, hydration, and empty localStorage.
 */
export const MANAGER_WORK_ORDERS_DEFAULT_SNAPSHOT: DemoManagerWorkOrderRow[] = EMPTY_FALLBACK;

function canUseStorage() {
  return typeof window !== "undefined";
}

function hydrateWorkOrdersFromSession() {
  if (!canUseStorage() || memoryRows.length > 0) return;
  try {
    const raw = window.sessionStorage.getItem(MANAGER_WORK_ORDERS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as DemoManagerWorkOrderRow[];
    if (!Array.isArray(parsed)) return;
    memoryRows = parsed;
  } catch {
    /* ignore */
  }
}

function persistWorkOrdersToSession(rows: DemoManagerWorkOrderRow[]) {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.setItem(MANAGER_WORK_ORDERS_SESSION_KEY, JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

function emit() {
  if (!canUseStorage()) return;
  window.dispatchEvent(new Event(MANAGER_WORK_ORDERS_EVENT));
}

function mirrorWorkOrdersToServer(rows: DemoManagerWorkOrderRow[]) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/portal-work-orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "replace", rows }),
  }).catch(() => undefined);
}

/** Awaited single-row upsert — used when a resident files a work order so a
 * failed mirror surfaces instead of leaving a local-only orphan. */
export async function upsertManagerWorkOrderToServer(
  row: DemoManagerWorkOrderRow,
): Promise<{ ok: true; row: DemoManagerWorkOrderRow } | { ok: false; error: string }> {
  if (typeof window === "undefined" || isDemoModeActive()) {
    return { ok: true, row };
  }
  try {
    const res = await fetch("/api/portal-work-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "upsert", row }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error?.trim() || `Save failed (${res.status})` };
    }
    const body = (await res.json().catch(() => null)) as { row?: DemoManagerWorkOrderRow } | null;
    return { ok: true, row: body?.row && typeof body.row === "object" ? body.row : row };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

function deleteWorkOrderFromServer(id: string) {
  if (typeof window === "undefined" || isDemoModeActive()) return;
  void fetch("/api/portal-work-orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "delete", id }),
  }).catch(() => undefined);
}

export async function syncManagerWorkOrdersFromServer(opts?: { force?: boolean }): Promise<DemoManagerWorkOrderRow[]> {
  if (!canUseStorage()) return [];
  hydrateWorkOrdersFromSession();
  if (isDemoModeActive()) return readManagerWorkOrderRows();
  const force = opts?.force === true;
  if (!force && managerWorkOrdersSyncPromise) return managerWorkOrdersSyncPromise;
  if (!force && managerWorkOrdersLastSyncedAt > 0 && Date.now() - managerWorkOrdersLastSyncedAt < MANAGER_WORK_ORDERS_SYNC_TTL_MS) {
    return readManagerWorkOrderRows();
  }
  try {
    managerWorkOrdersSyncPromise = (async () => {
      const res = await fetch("/api/portal-work-orders", { credentials: "include" });
      if (!res.ok) return readManagerWorkOrderRows();
      const body = (await res.json()) as { rows?: DemoManagerWorkOrderRow[] };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const changed = workOrderRowsChanged(memoryRows, rows);
      memoryRows = rows;
      persistWorkOrdersToSession(rows);
      managerWorkOrdersLastSyncedAt = Date.now();
      if (changed) emit();
      return rows;
    })();
    return await managerWorkOrdersSyncPromise;
  } catch {
    return readManagerWorkOrderRows();
  } finally {
    managerWorkOrdersSyncPromise = null;
  }
}

export function readManagerWorkOrderRows(fallback: DemoManagerWorkOrderRow[] = EMPTY_FALLBACK): DemoManagerWorkOrderRow[] {
  hydrateWorkOrdersFromSession();
  const stored = memoryRows;
  if (stored.length === 0) {
    return fallback === EMPTY_FALLBACK ? MANAGER_WORK_ORDERS_DEFAULT_SNAPSHOT : [...fallback];
  }
  const byId = new Map(stored.map((r) => [r.id, r]));
  const fallbackIds = new Set(fallback.map((f) => f.id));
  const merged = fallback.map((seed) => {
    const o = byId.get(seed.id);
    return o ? { ...seed, ...o } : seed;
  });
  const extras = stored.filter((s) => s.id && !fallbackIds.has(s.id));
  return [...merged, ...extras];
}

/**
 * Vendor-scoped read. The real `/vendor` route gets rows already scoped to the
 * signed-in vendor by the server (`vendor_user_id`) before they ever reach this
 * shared store, so this is a no-op outside the demo sandbox. The `/demo`
 * sandbox has no per-role server scoping — every persona reads the same
 * collapsed store — so filter by the demo vendor's name here instead.
 */
export function readVendorWorkOrderRows(): DemoManagerWorkOrderRow[] {
  const rows = readManagerWorkOrderRows();
  if (!isDemoModeActive()) return rows;
  // The Seattle Homes idle snapshot's own vendor story is Pacific Plumbing
  // (`demo-guided-data.ts`'s `vendors`/`workOrderBids`/`managerInbox` all name
  // it, matching the home page's Communication mock) — the demo `vendor` role
  // login is the neutral canonical `DEMO_VENDOR_NAME`, so a row assigned to
  // either name is "this vendor's job" in the sandbox.
  return rows.filter((r) => r.vendorName === DEMO_VENDOR_NAME || r.vendorName === "Pacific Plumbing");
}

export function writeManagerWorkOrderRows(
  rows: DemoManagerWorkOrderRow[],
  opts?: { mirror?: boolean },
): void {
  if (workOrderRowsChanged(memoryRows, rows) === false) return;
  memoryRows = rows;
  persistWorkOrdersToSession(rows);
  managerWorkOrdersLastSyncedAt = Date.now();
  emit();
  if (opts?.mirror !== false) mirrorWorkOrdersToServer(rows);
}

/** Demo seed: load work-order rows into the local store without server mirror. */
export function seedDemoManagerWorkOrderRows(rows: DemoManagerWorkOrderRow[]): void {
  if (!canUseStorage()) return;
  memoryRows = rows;
  persistWorkOrdersToSession(rows);
  managerWorkOrdersLastSyncedAt = Date.now();
  emit();
}

export function updateManagerWorkOrder(
  id: string,
  updater: (row: DemoManagerWorkOrderRow) => DemoManagerWorkOrderRow,
): void {
  const rows = readManagerWorkOrderRows();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const next = [...rows];
  next[idx] = updater(next[idx]!);
  writeManagerWorkOrderRows(next);
}

export function deleteManagerWorkOrderRow(id: string): boolean {
  if (!canUseStorage()) return false;
  const rows = readManagerWorkOrderRows();
  if (!rows.some((r) => r.id === id)) return false;
  removePendingWorkOrderChargesForWorkOrder(id);
  writeManagerWorkOrderRows(rows.filter((r) => r.id !== id));
  deleteWorkOrderFromServer(id);
  return true;
}

export function deleteManagerWorkOrdersForResident(residentEmail: string): number {
  if (!canUseStorage()) return 0;
  const email = residentEmail.trim().toLowerCase();
  if (!email) return 0;
  const rows = readManagerWorkOrderRows();
  const removedRows = rows.filter((row) => (row.residentEmail ?? "").trim().toLowerCase() === email);
  if (removedRows.length === 0) return 0;
  for (const row of removedRows) {
    removePendingWorkOrderChargesForWorkOrder(row.id);
  }
  writeManagerWorkOrderRows(rows.filter((row) => (row.residentEmail ?? "").trim().toLowerCase() !== email));
  return removedRows.length;
}

export function resetManagerWorkOrderRows(): void {
  memoryRows = [];
  if (canUseStorage()) window.sessionStorage.removeItem(MANAGER_WORK_ORDERS_SESSION_KEY);
  emit();
}
