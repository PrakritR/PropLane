import type { PortalKind } from "@/lib/portal-types";

/**
 * Desktop sidebar grouping — a pure presentation overlay on top of the flat
 * portal registries. Section ids are unchanged, so routes, render handlers, and
 * platform-parity tests are untouched; this only decides how the desktop sidebar
 * buckets sections under headings.
 *
 * `label: null` renders the items with no heading (Home row).
 * `profile` (Settings) has no row in ANY desktop sidebar — pro/manager,
 * resident, vendor, and admin all reach it only from the top-right account
 * menu (and, on a phone, the profile menu). It is excluded from sidebar
 * grouping entirely (see `SIDEBAR_EXCLUDED_SECTIONS`). Admin Feedback
 * (`bugs-feedback`) is a tab of the Support row; manager/resident/vendor
 * feedback stays inside Settings (embedded panel).
 */
export type NavGroupConfig = { id: string; label: string | null; sections: string[] };

/**
 * Sections never rendered in the desktop sidebar UNLESS a portal's own group
 * config explicitly assigns them (assignment in `groupNavItems` happens
 * before this set is even consulted — it only decides where an otherwise
 * UNASSIGNED section goes). No portal's group config assigns `profile`, so it
 * stays excluded everywhere and reachable only from the account menu.
 */
export const SIDEBAR_EXCLUDED_SECTIONS = new Set<string>([
  "profile",
  "bugs-feedback",
  /** App download lives under Settings; the redesign dropped it from every nav. */
  "app",
  /** Co-managers live under Settings → Workspaces (PLAN-0923-1934). */
  "teams",
]);

/**
 * Feedback is embedded inside Settings for manager/resident/vendor. Admin has a
 * dedicated Feedback sidebar entry instead.
 */
export function isHiddenFromMobileNav(kind: PortalKind, section: string): boolean {
  if (section === "bugs-feedback") return kind !== "admin";
  if (section === "move-in" && (kind === "manager" || kind === "pro")) return true;
  // Settings (`profile`) is reachable from the avatar menu AND the More sheet
  // (PLAN-0923-1805). It stays off the desktop sidebar and the fixed primary
  // bottom-bar slots — callers that build a top strip must still omit it.
  // App download page: reachable from Settings, never a nav destination.
  if (section === "app" && (kind === "manager" || kind === "pro")) return true;
  // Manager team management lives in Settings.
  if (section === "teams" && (kind === "manager" || kind === "pro")) return true;
  return false;
}

/** Hide the App download tab while already inside the native iOS/Android shell. */
export function isAppNavHiddenInNativeShell(kind: PortalKind, section: string, inNativeShell: boolean): boolean {
  return inNativeShell && (kind === "manager" || kind === "pro") && section === "app";
}

/*
 * Phase 1 shell redesign (approved plan dashboard-redesign-1007): four short
 * headed groups under an unheaded home group. Labels and section ids are
 * unchanged, only the bucketing moved. `payments` is "Incoming payments",
 * `outgoing` is "Outgoing payments" and `financials` is "Finances".
 * `app` (the download page) is deliberately not a sidebar row; it stays
 * routable from Settings and the native shell never showed it anyway.
 * Team (co-managers) is Settings -> Workspaces only; `/portal/teams` redirects.
 */
const PRO_GROUPS: NavGroupConfig[] = [
  { id: "home", label: null, sections: ["dashboard", "tasks", "calendar", "communication"] },
  { id: "portfolio", label: "Portfolio", sections: ["properties", "bookings", "promotion"] },
  { id: "leasing", label: "Leasing", sections: ["tours", "applications", "leases", "forms"] },
  { id: "people", label: "People", sections: ["residents", "vendors"] },
  // Captain #28: Services is work on the houses, not a person; Documents is records, not money.
  { id: "operations", label: "Operations", sections: ["services", "documents"] },
  { id: "money", label: "Money", sections: ["payments", "outgoing", "financials"] },
];

/**
 * Admin sidebar rows, in order. A grouped row (`accounts`, `money`, `support`)
 * stands for several sections; every other entry is a section id on its own.
 */
export const ADMIN_NAV_ROW_ORDER = [
  "profile",
  "dashboard",
  "communication",
  "property",
  "accounts",
  "money",
  "support",
  "growth",
] as const;

export type AdminSectionTabGroup = { label: string; sections: readonly string[] };

/**
 * The one source for admin's grouped navigation (portal sweep 1012, round 1):
 * each group is ONE sidebar row, and its sections are the tabs of the strip
 * along the top of every page in the group. Section ids, routes and
 * `adminPortal.sections` are unchanged; this only decides how they are shown.
 * The first section is the group's row key (the row links to it and is
 * highlighted on any member). `test-accounts` is operator-only: the layout
 * drops it from the definition, and every derivation below works from the
 * sections actually present.
 */
export const ADMIN_SECTION_TABS: Record<string, AdminSectionTabGroup> = {
  // The "Property management" half (one-number W15): PropLane's own managed portfolio. The row stays keyed on
  // `properties`, the key the native bottom bar and every older link already use.
  property: { label: "Properties", sections: ["properties", "service", "proplane-line", "unassigned-leads"] },
  accounts: { label: "Accounts", sections: ["axis-users", "subscribers", "test-accounts"] },
  money: { label: "Money", sections: ["payments", "promo-codes", "finances", "managed-finance"] },
  support: { label: "Support", sections: ["bugs-feedback", "events", "health"] },
};

/**
 * The seven sidebar row keys, in row order: a grouped row is keyed on its
 * group's first section, every other row on its own section.
 */
export const ADMIN_NAV_ROW_SECTIONS: readonly string[] = ADMIN_NAV_ROW_ORDER.map(
  (id) => ADMIN_SECTION_TABS[id]?.sections[0] ?? id,
);

/** The group a section is a tab of, or null for a section that is a row on its own. */
export function adminTabGroupIdFor(section: string): string | null {
  for (const [id, group] of Object.entries(ADMIN_SECTION_TABS)) {
    if (group.sections.includes(section)) return id;
  }
  return null;
}

/** The sidebar row key a section belongs to: its group's first section, or itself. */
export function adminNavRowSection(section: string): string {
  const id = adminTabGroupIdFor(section);
  return id ? ADMIN_SECTION_TABS[id]!.sections[0]! : section;
}

/**
 * The tab strip for an admin section: its group's label and the member sections
 * that are actually available (so an operator-only tab never appears for anyone
 * else), in tab order. Null for Dashboard, Communication, Properties, Growth and
 * anything else that is not part of a group.
 */
export function adminSectionTabsFor(
  section: string,
  availableSections: readonly string[],
): { groupId: string; label: string; sections: string[] } | null {
  const groupId = adminTabGroupIdFor(section);
  if (!groupId) return null;
  const group = ADMIN_SECTION_TABS[groupId]!;
  const available = new Set(availableSections);
  const sections = group.sections.filter((id) => available.has(id));
  if (sections.length === 0) return null;
  return { groupId, label: group.label, sections };
}

/**
 * Fold flat admin nav items into one row per group. The row is keyed on
 * `adminNavRowSection` — the group's first configured section, the one key
 * `mergeAdminGroupCounts` and `NATIVE_BOTTOM_NAV_ADMIN_PRIMARY` also use, so a
 * filtered-out first tab can never leave the row's key and its active/count key
 * disagreeing — while href, icon and prefetch come from the first tab actually
 * visible. Every member is remembered in `groupSections` so the row is active on
 * any of them. Idempotent: an already-folded row is passed through.
 */
export function collapseAdminNavItems<T extends { section: string; label: string }>(
  items: T[],
): (T & { groupSections?: string[] })[] {
  const out: (T & { groupSections?: string[] })[] = [];
  const done = new Set<string>();
  for (const item of items) {
    const groupId = adminTabGroupIdFor(item.section);
    if (!groupId) {
      out.push(item);
      continue;
    }
    if (done.has(groupId)) continue;
    done.add(groupId);
    const group = ADMIN_SECTION_TABS[groupId]!;
    const members = items.filter((i) => group.sections.includes(i.section));
    const existing = members.find((m) => (m as { groupSections?: string[] }).groupSections);
    if (existing) {
      out.push(existing as T & { groupSections?: string[] });
      continue;
    }
    const first = group.sections
      .map((id) => members.find((m) => m.section === id))
      .find((m): m is T => Boolean(m));
    if (!first) continue;
    out.push({
      ...first,
      section: group.sections[0]!,
      label: group.label,
      groupSections: group.sections.filter((id) => members.some((m) => m.section === id)),
    });
  }
  return out;
}

/**
 * Nav badge counts for the folded admin rows: a grouped row carries the sum of
 * its members' counts (Support shows the open Meetings and Feedback), alert if
 * any member is. Counts of the members are left as they are for the tab strip.
 */
export function mergeAdminGroupCounts<C extends { count: number; tone: "muted" | "alert" }>(
  counts: Partial<Record<string, C>>,
): Partial<Record<string, C>> {
  const merged: Partial<Record<string, C>> = { ...counts };
  for (const group of Object.values(ADMIN_SECTION_TABS)) {
    const rowKey = group.sections[0]!;
    let total = 0;
    let alert = false;
    for (const id of group.sections) {
      const c = counts[id];
      if (!c) continue;
      total += c.count;
      if (c.tone === "alert" && c.count > 0) alert = true;
    }
    merged[rowKey] = { count: total, tone: alert ? "alert" : "muted" } as C;
  }
  return merged;
}

const adminRowSections = (...ids: (typeof ADMIN_NAV_ROW_ORDER)[number][]) =>
  ids.flatMap((id) => ADMIN_SECTION_TABS[id]?.sections ?? [id]);

/**
 * Two headed halves (one-number W15): "Property management" is PropLane's own managed portfolio (the service
 * workspaces per city, the PropLane line, the unassigned leads, the all-owners Properties oversight) and
 * "Software" is the subscriptions PropLane sells (Accounts, Subscribers, Payments, Promo codes, Finances).
 * Admin Settings is the very first row, then Dashboard and Communication, then the two halves, with Support and Growth below. Members of a folded group are listed
 * inline after their row key so this config buckets BOTH shapes: the sidebar's folded rows
 * (`collapseAdminNavItems`, keyed on the group's first section) and the unfolded sections the command palette
 * jumps to. Settings (`profile`) is also still in the account menu, unchanged.
 */
const ADMIN_GROUPS: NavGroupConfig[] = [
  // Admin Settings (`profile`) is the FIRST sidebar row (captain, Oct 18) and the `/admin` landing. Assigning it to a
  // group is what puts it in the sidebar at all: `SIDEBAR_EXCLUDED_SECTIONS` only applies to unassigned sections.
  { id: "settings", label: null, sections: ["profile"] },
  { id: "home", label: null, sections: adminRowSections("dashboard", "communication") },
  { id: "property-management", label: "Property management", sections: adminRowSections("property") },
  { id: "software", label: "Software", sections: adminRowSections("accounts", "money") },
  { id: "platform", label: null, sections: adminRowSections("support", "growth") },
];

// Captain #28: the resident's journey in order, Applying, then the Home they live in (`move-in` is the "My home"
// row), the Lease and its Paperwork, then Money. Stage locks and unlocks are unchanged: this only buckets the rows.
// The group is headed "Paperwork", not "Lease", so no heading repeats its first row (R13).
const RESIDENT_GROUPS: NavGroupConfig[] = [
  { id: "home", label: null, sections: ["dashboard", "stays", "communication"] },
  { id: "applying", label: "Applying", sections: ["tour", "applications"] },
  { id: "my-home", label: "Home", sections: ["move-in", "services"] },
  { id: "lease", label: "Paperwork", sections: ["lease", "forms", "documents"] },
  { id: "money", label: "Money", sections: ["payments"] },
];

// Captain #28: Reviews and Documents are the vendor's business record, not the work queue or money.
const VENDOR_GROUPS: NavGroupConfig[] = [
  { id: "home", label: null, sections: ["dashboard", "communication", "calendar"] },
  { id: "work", label: "Work", sections: ["work-orders"] },
  { id: "money", label: "Money", sections: ["payments", "outgoing", "financials"] },
  { id: "business", label: "Business", sections: ["reviews", "documents"] },
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
      // Manager Teams moved into Settings (Workspaces / Team / Vendors).
      !((kind === "manager" || kind === "pro") && i.section === "teams") &&
      // Manager Move-in has no sidebar row any more (Forms replaced it); the section stays registered only
      // so a single inspection report keeps its address. Residents assign `move-in` in their own group.
      !((kind === "manager" || kind === "pro") && i.section === "move-in"),
  );
  if (leftovers.length) groups.push({ id: "more", label: null, items: leftovers });

  return groups.filter((g) => g.items.length > 0);
}
