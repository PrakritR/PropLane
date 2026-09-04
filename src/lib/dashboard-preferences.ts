/**
 * Per-user manager-dashboard customization.
 *
 * The manager dashboard renders a fixed catalog of sections (the cash-flow chart
 * plus the "Needs attention" groups). A manager can hide sections they don't
 * care about; the choice is persisted per user in localStorage so it survives
 * reloads without a round-trip. Someone who never opens the customizer sees the
 * sensible defaults below.
 *
 * Storage shape: `Partial<Record<DashboardSectionId, boolean>>` — only explicit
 * overrides are stored; an absent id falls back to its `defaultVisible`. A tiny
 * window event lets the open dashboard react to changes made in the customizer
 * modal (and to edits from another tab via the native `storage` event).
 */

export type DashboardSectionId =
  | "cashflow"
  | "aiDrafts"
  | "tours"
  | "applications"
  | "leases"
  | "residents"
  | "payments"
  | "services"
  | "inbox";

export type DashboardSectionDef = {
  id: DashboardSectionId;
  label: string;
  description: string;
  defaultVisible: boolean;
};

/**
 * Catalog of customizable manager-dashboard sections, in render order. The KPI
 * stat row is intentionally NOT here — it is the always-on "at a glance" layer.
 */
export const MANAGER_DASHBOARD_SECTIONS: readonly DashboardSectionDef[] = [
  {
    id: "cashflow",
    label: "Cash flow",
    description: "Payments collected vs. expenses, last 6 months.",
    defaultVisible: true,
  },
  {
    id: "aiDrafts",
    label: "AI drafts",
    description: "Assistant-proposed actions awaiting your approval.",
    defaultVisible: true,
  },
  {
    id: "tours",
    label: "Tour requests",
    description: "Pending and confirmed property tours.",
    defaultVisible: true,
  },
  {
    id: "applications",
    label: "Applications to approve",
    description: "Submitted applications awaiting your approval.",
    defaultVisible: true,
  },
  {
    id: "leases",
    label: "Leases pending signature",
    description: "Leases waiting on you or the resident.",
    defaultVisible: true,
  },
  {
    id: "residents",
    label: "Residents",
    description: "Current residents on signed leases.",
    defaultVisible: true,
  },
  {
    id: "payments",
    label: "Pending & overdue payments",
    description: "Household charges still owed.",
    defaultVisible: true,
  },
  {
    id: "services",
    label: "Services needed",
    description: "Open services, scheduled visits, and pending add-on requests.",
    defaultVisible: true,
  },
  {
    id: "inbox",
    label: "Communication",
    description: "Unread manager messages.",
    defaultVisible: true,
  },
] as const;

const SECTION_BY_ID = new Map(MANAGER_DASHBOARD_SECTIONS.map((s) => [s.id, s]));
const VALID_IDS = new Set(MANAGER_DASHBOARD_SECTIONS.map((s) => s.id));

const STORAGE_KEY_PREFIX = "axis:manager-dashboard-prefs:v1";
/** Dispatched on `window` after any preference write so the dashboard re-reads. */
export const DASHBOARD_PREFS_EVENT = "axis:manager-dashboard-prefs";

export type DashboardVisibility = Record<DashboardSectionId, boolean>;

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${userId}`;
}

/** Fully-resolved defaults (all sections at their `defaultVisible`). */
export function defaultDashboardVisibility(): DashboardVisibility {
  const out = {} as DashboardVisibility;
  for (const section of MANAGER_DASHBOARD_SECTIONS) out[section.id] = section.defaultVisible;
  return out;
}

function parseOverrides(raw: string | null): Partial<Record<DashboardSectionId, boolean>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<DashboardSectionId, boolean>> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (VALID_IDS.has(k as DashboardSectionId) && typeof v === "boolean") {
        out[k as DashboardSectionId] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolved visibility for every section for `userId`: stored overrides layered
 * over the catalog defaults. Safe to call on the server (returns defaults).
 */
export function readDashboardVisibility(userId: string | null | undefined): DashboardVisibility {
  const base = defaultDashboardVisibility();
  if (!userId || typeof window === "undefined") return base;
  let overrides: Partial<Record<DashboardSectionId, boolean>>;
  try {
    overrides = parseOverrides(window.localStorage.getItem(storageKey(userId)));
  } catch {
    return base;
  }
  for (const [id, visible] of Object.entries(overrides)) {
    base[id as DashboardSectionId] = visible as boolean;
  }
  return base;
}

/** Persist a single section's visibility and notify listeners. No-op on server. */
export function setDashboardSectionVisibility(
  userId: string | null | undefined,
  id: DashboardSectionId,
  visible: boolean,
): void {
  if (!userId || typeof window === "undefined" || !VALID_IDS.has(id)) return;
  try {
    const overrides = parseOverrides(window.localStorage.getItem(storageKey(userId)));
    const section = SECTION_BY_ID.get(id);
    if (section && visible === section.defaultVisible) {
      // Back to default — drop the override so future default changes apply.
      delete overrides[id];
    } else {
      overrides[id] = visible;
    }
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(storageKey(userId));
    } else {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(overrides));
    }
    window.dispatchEvent(new Event(DASHBOARD_PREFS_EVENT));
  } catch {
    // Storage full / disabled — customization silently no-ops rather than throwing.
  }
}

/** Clear all overrides for `userId`, restoring catalog defaults. */
export function resetDashboardVisibility(userId: string | null | undefined): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(userId));
    window.dispatchEvent(new Event(DASHBOARD_PREFS_EVENT));
  } catch {
    // ignore
  }
}
