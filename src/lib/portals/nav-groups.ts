import type { PortalKind } from "@/lib/portal-types";

/**
 * Desktop sidebar grouping — a pure presentation overlay on top of the flat
 * portal registries. Section ids are unchanged, so routes, render handlers, and
 * platform-parity tests are untouched; this only decides how the desktop sidebar
 * buckets sections under headings.
 *
 * `label: null` renders the items with no heading (Home row).
 * `profile` (Settings) is excluded from the desktop sidebar — it lives in the
 * top-right account menu (and the mobile profile menu). Admin Feedback
 * (`bugs-feedback`) is a standalone Operations item; manager/resident/vendor
 * feedback stays inside Settings (embedded panel).
 */
export type NavGroupConfig = { id: string; label: string | null; sections: string[] };

/** Sections never rendered in the desktop sidebar (Settings → account menu). */
export const SIDEBAR_EXCLUDED_SECTIONS = new Set<string>([
  "profile",
  "bugs-feedback",
  /** App download lives under Settings; the redesign dropped it from every nav. */
  "app",
  /** Nested under Leasing → Application submenu; not a second sidebar row. */
  "background-checks",
]);

/**
 * Feedback is embedded inside Settings for manager/resident/vendor. Admin has a
 * dedicated Feedback sidebar entry instead.
 */
export function isHiddenFromMobileNav(kind: PortalKind, section: string): boolean {
  if (section === "bugs-feedback") return kind !== "admin";
  // Settings → mobile profile menu (same as desktop sidebar exclusion).
  if (section === "profile") return true;
  // App download page: reachable from Settings, never a nav destination.
  if (section === "app" && (kind === "manager" || kind === "pro")) return true;
  // Vendor tasks sit inside Services.
  if (section === "tasks" && kind === "vendor") return true;
  // Manager team management lives in Settings.
  if (section === "teams" && (kind === "manager" || kind === "pro")) return true;
  return false;
}

/** Hide the App download tab while already inside the native iOS/Android shell. */
export function isAppNavHiddenInNativeShell(kind: PortalKind, section: string, inNativeShell: boolean): boolean {
  return inNativeShell && (kind === "manager" || kind === "pro") && section === "app";
}

const PRO_GROUPS: NavGroupConfig[] = [
  // Portfolio first: the workspace's own two destinations sit above the lifecycle
  // groups. `app` (the download page) is deliberately not a sidebar row any more —
  // it stays routable from Settings and the native shell never showed it anyway.
  { id: "workspace", label: "Workspace", sections: ["dashboard", "properties"] },
  { id: "leasing", label: "Leasing", sections: ["tours", "applications", "leases"] },
  { id: "tenancy", label: "Tenancy", sections: ["residents", "inspections", "payments", "services"] },
  { id: "operations", label: "Operations", sections: ["tasks", "calendar", "bookings", "communication"] },
  { id: "marketing", label: "Marketing", sections: ["promotion"] },
  // Team (managers, vendors) is managed under Settings → Workspaces / Team / Vendors;
  // the /teams routes stay reachable for deep links and detail pages.
  { id: "finances", label: "Finances", sections: ["financials", "documents"] },
];

const ADMIN_GROUPS: NavGroupConfig[] = [
  { id: "home", label: null, sections: ["dashboard"] },
  { id: "portfolio", label: "Portfolio", sections: ["properties"] },
  { id: "people", label: "People", sections: ["axis-users", "billing"] },
  { id: "operations", label: "Operations", sections: ["events", "communication", "bugs-feedback"] },
];

const RESIDENT_GROUPS: NavGroupConfig[] = [
  { id: "home", label: null, sections: ["dashboard", "tour", "applications"] },
  { id: "my-home", label: "My home", sections: ["lease", "move-in", "services", "inspections"] },
  { id: "finances", label: "Finances", sections: ["payments", "documents"] },
  { id: "messages", label: "Messages", sections: ["communication"] },
];

const VENDOR_GROUPS: NavGroupConfig[] = [
  { id: "home", label: null, sections: ["dashboard"] },
  // Vendor tasks live inside Services (a tab there); the route stays but is not a row.
  { id: "work", label: "Work", sections: ["work-orders", "calendar"] },
  { id: "operations", label: "Operations", sections: ["communication"] },
  { id: "finances", label: "Finances", sections: ["financials", "payments", "documents"] },
];

export const PORTAL_NAV_GROUPS: Record<PortalKind, NavGroupConfig[]> = {
  pro: PRO_GROUPS,
  manager: PRO_GROUPS,
  admin: ADMIN_GROUPS,
  resident: RESIDENT_GROUPS,
  vendor: VENDOR_GROUPS,
};

export type GroupedNav<T> = { id: string; label: string | null; items: T[] };

/**
 * Bucket flat nav items into the portal's groups, preserving config order within
 * each group. Items not in any group (and not excluded) fall into a trailing
 * unlabeled group so nothing silently disappears.
 */
export function groupNavItems<T extends { section: string }>(
  kind: PortalKind,
  items: T[],
): GroupedNav<T>[] {
  const bySection = new Map<string, T[]>();
  for (const item of items) {
    const list = bySection.get(item.section) ?? [];
    list.push(item);
    bySection.set(item.section, list);
  }

  // Application phase: show all sections in sidebar groups; locks are stage-based.
  const config = PORTAL_NAV_GROUPS[kind] ?? [];
  const assigned = new Set<string>();

  const groups: GroupedNav<T>[] = config.map((g) => {
    const groupItems: T[] = [];
    for (const id of g.sections) {
      const sectionItems = bySection.get(id);
      if (sectionItems?.length) {
        groupItems.push(...sectionItems);
        assigned.add(id);
      }
    }
    return { id: g.id, label: g.label, items: groupItems };
  });

  const leftovers = items.filter(
    (i) =>
      !assigned.has(i.section) &&
      !SIDEBAR_EXCLUDED_SECTIONS.has(i.section) &&
      // Vendor tasks are a Services tab, not a row; the route stays reachable.
      !(kind === "vendor" && i.section === "tasks") &&
      // Manager Teams moved into Settings (Workspaces / Team / Vendors).
      !((kind === "manager" || kind === "pro") && i.section === "teams"),
  );
  if (leftovers.length) groups.push({ id: "more", label: null, items: leftovers });

  return groups.filter((g) => g.items.length > 0);
}
