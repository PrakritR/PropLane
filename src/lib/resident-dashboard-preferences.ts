/**
 * Per-user resident-dashboard customization (Needs attention groups).
 * KPI stat row stays always on; groups below are toggleable like the manager dashboard.
 */

export type ResidentDashboardSectionId =
  | "tours"
  | "applications"
  | "lease"
  | "houseDetails"
  | "services"
  | "payments"
  | "communication";

export type ResidentDashboardSectionDef = {
  id: ResidentDashboardSectionId;
  label: string;
  description: string;
  defaultVisible: boolean;
};

export const RESIDENT_DASHBOARD_SECTIONS: readonly ResidentDashboardSectionDef[] = [
  {
    id: "tours",
    label: "Tour pending",
    description: "Property tour requests awaiting confirmation.",
    defaultVisible: true,
  },
  {
    id: "applications",
    label: "Application pending",
    description: "Submitted applications still under review.",
    defaultVisible: true,
  },
  {
    id: "lease",
    label: "Lease",
    description: "Signature and lease status updates.",
    defaultVisible: true,
  },
  {
    id: "houseDetails",
    label: "House details",
    description: "Move-in placement, keys, and house information.",
    defaultVisible: true,
  },
  {
    id: "services",
    label: "Services",
    description: "Open services and pending add-on service requests.",
    defaultVisible: true,
  },
  {
    id: "payments",
    label: "Payments",
    description: "Outstanding charges on your account.",
    defaultVisible: true,
  },
  {
    id: "communication",
    label: "Communication",
    description: "Unread messages from your property manager.",
    defaultVisible: true,
  },
] as const;

const SECTION_BY_ID = new Map(RESIDENT_DASHBOARD_SECTIONS.map((s) => [s.id, s]));
const VALID_IDS = new Set(RESIDENT_DASHBOARD_SECTIONS.map((s) => s.id));

const STORAGE_KEY_PREFIX = "axis:resident-dashboard-prefs:v1";
export const RESIDENT_DASHBOARD_PREFS_EVENT = "axis:resident-dashboard-prefs";

export type ResidentDashboardVisibility = Record<ResidentDashboardSectionId, boolean>;

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${userId}`;
}

export function defaultResidentDashboardVisibility(): ResidentDashboardVisibility {
  const out = {} as ResidentDashboardVisibility;
  for (const section of RESIDENT_DASHBOARD_SECTIONS) out[section.id] = section.defaultVisible;
  return out;
}

function parseOverrides(raw: string | null): Partial<Record<ResidentDashboardSectionId, boolean>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<ResidentDashboardSectionId, boolean>> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (VALID_IDS.has(k as ResidentDashboardSectionId) && typeof v === "boolean") {
        out[k as ResidentDashboardSectionId] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function readResidentDashboardVisibility(userId: string | null | undefined): ResidentDashboardVisibility {
  const base = defaultResidentDashboardVisibility();
  if (!userId || typeof window === "undefined") return base;
  let overrides: Partial<Record<ResidentDashboardSectionId, boolean>>;
  try {
    overrides = parseOverrides(window.localStorage.getItem(storageKey(userId)));
  } catch {
    return base;
  }
  for (const [id, visible] of Object.entries(overrides)) {
    base[id as ResidentDashboardSectionId] = visible as boolean;
  }
  return base;
}

export function setResidentDashboardSectionVisibility(
  userId: string | null | undefined,
  id: ResidentDashboardSectionId,
  visible: boolean,
): void {
  if (!userId || typeof window === "undefined" || !VALID_IDS.has(id)) return;
  try {
    const overrides = parseOverrides(window.localStorage.getItem(storageKey(userId)));
    const section = SECTION_BY_ID.get(id);
    if (section && visible === section.defaultVisible) {
      delete overrides[id];
    } else {
      overrides[id] = visible;
    }
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(storageKey(userId));
    } else {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(overrides));
    }
    window.dispatchEvent(new Event(RESIDENT_DASHBOARD_PREFS_EVENT));
  } catch {
    // ignore
  }
}

export function resetResidentDashboardVisibility(userId: string | null | undefined): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(userId));
    window.dispatchEvent(new Event(RESIDENT_DASHBOARD_PREFS_EVENT));
  } catch {
    // ignore
  }
}
