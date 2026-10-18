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

/**
 * One sidebar row standing for several sections (portal simplification, Oct 18). The row is keyed on `key`
 * (default: the first section) and its `sections` are, in tab order, the tabs of the strip along the top of
 * every page in the group. Section ids, URLs, handlers, tier gates and stage guards are untouched: this only
 * decides how the sections are SHOWN. A lock applies to a TAB (its own section), never to the whole row.
 */
export type NavFoldGroup = {
  label: string;
  sections: readonly string[];
  key?: string;
  /** A shorter name for a section when it is a TAB of this row ("Incoming" for "Incoming payments"). */
  tabLabels?: Readonly<Record<string, string>>;
};
export type NavFoldConfig = Record<string, NavFoldGroup>;

/** The sidebar row key of a group: `key`, else its first section. */
export function navFoldKey(group: NavFoldGroup): string {
  return group.key ?? group.sections[0]!;
}

/**
 * Manager and pro share one shape: six rows. Home holds the three "what is happening" pages, Properties the
 * three views of the portfolio, Leasing the pipeline from a tour to a signed lease, People the humans and the
 * work they do, Money every ledger and its documents. `communication` is a row on its own (a push and email
 * deep-link target).
 */
const PRO_FOLDS: NavFoldConfig = {
  home: { label: "Home", sections: ["dashboard", "calendar", "tasks"] },
  properties: { label: "Properties", sections: ["properties", "bookings", "promotion"] },
  leasing: { label: "Leasing", sections: ["tours", "applications", "leases", "forms"], key: "leases" },
  people: { label: "People", sections: ["residents", "vendors", "services"] },
  money: {
    label: "Money",
    sections: ["payments", "outgoing", "financials", "documents"],
    tabLabels: { payments: "Incoming", outgoing: "Outgoing" },
  },
};
const PRO_ROW_ORDER = ["home", "communication", "properties", "leasing", "people", "money"] as const;

/**
 * Resident: five rows. My home holds everything about the house and the tenancy; Applying is the stage-locked
 * entry before approval (Tour, Application). Stays is the conditional second tab of Home. `STAGE_UNLOCKED_SECTIONS`
 * stays per SECTION: a row is locked only when every one of its tabs is.
 */
const RESIDENT_FOLDS: NavFoldConfig = {
  home: { label: "Home", sections: ["dashboard", "stays"] },
  "my-home": { label: "My home", sections: ["move-in", "lease", "forms", "services"] },
  applying: { label: "Applying", sections: ["tour", "applications"], key: "applications" },
  money: { label: "Money", sections: ["payments", "documents"] },
};
const RESIDENT_ROW_ORDER = ["home", "communication", "my-home", "applying", "money"] as const;

/** Vendor: four rows. */
const VENDOR_FOLDS: NavFoldConfig = {
  home: { label: "Home", sections: ["dashboard"] },
  work: { label: "Work", sections: ["work-orders", "calendar", "reviews"] },
  money: {
    label: "Money",
    sections: ["payments", "outgoing", "financials", "documents"],
    tabLabels: { payments: "Incoming", outgoing: "Outgoing" },
  },
};
const VENDOR_ROW_ORDER = ["home", "work", "communication", "money"] as const;

/**
 * Admin sidebar rows, in order. Property management is PropLane's own managed portfolio; Software is what
 * PropLane sells. Support's Feedback, Meetings and Health are tabs of the Dashboard row.
 */
const ADMIN_FOLDS: NavFoldConfig = {
  // The "Property management" half (one-number W15): PropLane's own managed portfolio. The row stays keyed on
  // `properties`, the key the native bottom bar and every older link already use.
  property: { label: "Properties", sections: ["properties", "service", "proplane-line", "unassigned-leads"] },
  accounts: { label: "Accounts", sections: ["axis-users", "subscribers", "test-accounts"] },
  money: { label: "Money", sections: ["payments", "promo-codes", "finances"] },
  dashboard: { label: "Dashboard", sections: ["dashboard", "bugs-feedback", "events", "health"] },
};
const ADMIN_ROW_ORDER = [
  "profile",
  "dashboard",
  "communication",
  "property",
  "accounts",
  "money",
  "growth",
] as const;

export const NAV_FOLDS: Record<PortalKind, NavFoldConfig> = {
  pro: PRO_FOLDS,
  manager: PRO_FOLDS,
  resident: RESIDENT_FOLDS,
  vendor: VENDOR_FOLDS,
  admin: ADMIN_FOLDS,
};

/** Sidebar row ids per portal, in order: a fold group id, or a section that is a row on its own. */
export const NAV_ROW_ORDER: Record<PortalKind, readonly string[]> = {
  pro: PRO_ROW_ORDER,
  manager: PRO_ROW_ORDER,
  resident: RESIDENT_ROW_ORDER,
  vendor: VENDOR_ROW_ORDER,
  admin: ADMIN_ROW_ORDER,
};

/** The sidebar row keys of a portal, in row order. */
export function navRowSections(kind: PortalKind): string[] {
  const folds = NAV_FOLDS[kind];
  return NAV_ROW_ORDER[kind].map((id) => (folds[id] ? navFoldKey(folds[id]!) : id));
}

/** The fold group a section is a tab of (its id), or null for a section that is a row on its own. */
export function navFoldIdFor(kind: PortalKind, section: string): string | null {
  for (const [id, group] of Object.entries(NAV_FOLDS[kind] ?? {})) {
    if (group.sections.includes(section)) return id;
  }
  return null;
}

/** The sidebar row key a section belongs to: its group's key, or itself. */
export function navRowSection(kind: PortalKind, section: string): string {
  const id = navFoldIdFor(kind, section);
  return id ? navFoldKey(NAV_FOLDS[kind][id]!) : section;
}

/**
 * The tab strip for a section: its group's label and the member sections that are actually available (so an
 * operator-only or stage-hidden tab never appears for anyone else), in tab order. Null for a section that is
 * a row on its own and for a group with fewer than two available tabs (one tab is not a strip).
 */
export function navSectionTabsFor(
  kind: PortalKind,
  section: string,
  availableSections: readonly string[],
): { groupId: string; label: string; sections: string[]; tabLabels: Readonly<Record<string, string>> } | null {
  const groupId = navFoldIdFor(kind, section);
  if (!groupId) return null;
  const group = NAV_FOLDS[kind][groupId]!;
  const available = new Set(availableSections);
  const sections = group.sections.filter((id) => available.has(id));
  if (sections.length < 2) return null;
  return { groupId, label: group.label, sections, tabLabels: group.tabLabels ?? {} };
}

/**
 * Fold flat nav items into one row per group. The row is keyed on the group's key (the one key
 * `mergeGroupCounts` and the native bottom bar also use) while href, icon and prefetch come from the first tab
 * actually available and, when `isLocked` is given, not locked, so a row never opens on a paywall while a free
 * tab exists. Every member is remembered in `groupSections` so the row is active on any of them. Idempotent:
 * an already-folded row is passed through.
 */
export function collapseNavItems<T extends { section: string; label: string }>(
  kind: PortalKind,
  items: T[],
  opts?: { isLocked?: (section: string) => boolean },
): (T & { groupSections?: string[] })[] {
  const out: (T & { groupSections?: string[] })[] = [];
  const done = new Set<string>();
  const folds = NAV_FOLDS[kind] ?? {};
  for (const item of items) {
    const groupId = navFoldIdFor(kind, item.section);
    if (!groupId) {
      out.push(item);
      continue;
    }
    if (done.has(groupId)) continue;
    done.add(groupId);
    const group = folds[groupId]!;
    const members = items.filter((i) => group.sections.includes(i.section));
    const existing = members.find((m) => (m as { groupSections?: string[] }).groupSections);
    if (existing) {
      out.push(existing as T & { groupSections?: string[] });
      continue;
    }
    const ordered = group.sections
      .map((id) => members.find((m) => m.section === id))
      .filter((m): m is T => Boolean(m));
    const first = ordered.find((m) => !opts?.isLocked?.(m.section)) ?? ordered[0];
    if (!first) continue;
    out.push({
      ...first,
      section: navFoldKey(group),
      label: group.label,
      // A nested sub-nav belongs to its section's own page, not to the folded row.
      subItems: undefined,
      sectionTabId: undefined,
      groupSections: ordered.map((m) => m.section),
    });
  }
  return out;
}

/**
 * Nav badge counts for the folded rows: a grouped row carries the sum of its members' counts, alert if any
 * member is. Counts of the members are left as they are for the tab strip.
 */
export function mergeGroupCounts<C extends { count: number; tone: "muted" | "alert" }>(
  kind: PortalKind,
  counts: Partial<Record<string, C>>,
): Partial<Record<string, C>> {
  const merged: Partial<Record<string, C>> = { ...counts };
  for (const group of Object.values(NAV_FOLDS[kind] ?? {})) {
    const rowKey = navFoldKey(group);
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

/**
 * Second and third path segments that name a LIST view (a bucket, a tab, a direction), never a record. The
 * tab strip of a folded row draws on a section's list pages only: `/portal/leases/signed` yes,
 * `/portal/leases/signed/<id>` and `/portal/vendors/<id>` no. Fail closed: an unknown segment is a record.
 */
const LIST_VIEW_SEGMENTS = new Set([
  "all", "listed", "drafts", "unlisted", "pending", "approved", "rejected", "upcoming", "past", "draft",
  "manager", "resident", "signed", "completed", "current", "potential", "calendar", "in-house", "active",
  "archived", "escalations", "unread", "overview", "reports", "applications", "leases", "other", "library",
  "templates", "income-documents", "expense-documents", "occupancy", "1099", "tax-summary", "tax", "license",
  "insurance", "statements", "from-managers", "requests", "work-orders", "open", "assigned", "scheduled",
  "to-pay", "paid", "overdue", "this-month", "last-month", "earlier", "payouts", "refunds", "incoming",
  "outgoing", "listing-sites", "tours", "services", "tasks", "my-home", "roommates", "details", "placement",
  "inspections", "signing", "to-sign", "archive", "sent", "scheduled-sends", "in-progress", "apply",
]);

/**
 * Whether a path (the segments after the portal base path, e.g. `["leases", "signed"]`) is the list level of
 * its section, so a folded row's tab strip belongs on it.
 */
export function isSectionListPath(rest: readonly string[]): boolean {
  if (rest.length === 0) return false;
  if (rest.length === 1) return true;
  if (rest.length > 3) return false;
  return rest.slice(1).every((seg) => LIST_VIEW_SEGMENTS.has(seg));
}

// ---- Admin (kept as named wrappers: older callers and tests read these) -------------------------------------

export const ADMIN_NAV_ROW_ORDER = ADMIN_ROW_ORDER;
export type AdminSectionTabGroup = NavFoldGroup;
export const ADMIN_SECTION_TABS: NavFoldConfig = ADMIN_FOLDS;
export const ADMIN_NAV_ROW_SECTIONS: readonly string[] = navRowSections("admin");
export const adminTabGroupIdFor = (section: string) => navFoldIdFor("admin", section);
export const adminNavRowSection = (section: string) => navRowSection("admin", section);
export const adminSectionTabsFor = (section: string, availableSections: readonly string[]) =>
  navSectionTabsFor("admin", section, availableSections);
export const collapseAdminNavItems = <T extends { section: string; label: string }>(items: T[]) =>
  collapseNavItems("admin", items);
export const mergeAdminGroupCounts = <C extends { count: number; tone: "muted" | "alert" }>(
  counts: Partial<Record<string, C>>,
) => mergeGroupCounts("admin", counts);

/** A fold group's key first, then its other members, so a config buckets BOTH the folded and unfolded shapes. */
function rowSections(kind: PortalKind, ids: readonly string[]): string[] {
  const folds = NAV_FOLDS[kind];
  return ids.flatMap((id) => {
    const group = folds[id];
    if (!group) return [id];
    const key = navFoldKey(group);
    return [key, ...group.sections.filter((s) => s !== key)];
  });
}

const rowIds = (kind: PortalKind, ...ids: string[]) => rowSections(kind, ids);

/**
 * Admin has two headed halves (one-number W15): "Property management" is PropLane's own managed portfolio and
 * "Software" is the subscriptions PropLane sells (Accounts, Money, Growth). Admin Settings is the very first
 * row. Members of a folded group are listed inline after their row key so this config buckets BOTH shapes: the
 * sidebar's folded rows and the unfolded sections the command palette jumps to.
 */
const ADMIN_GROUPS: NavGroupConfig[] = [
  // Admin Settings (`profile`) is the FIRST sidebar row (captain, Oct 18) and the `/admin` landing, and now the
  // ONLY Settings entry for admin (the account menu drops its duplicate). Assigning it to a group is what puts it
  // in the sidebar at all: `SIDEBAR_EXCLUDED_SECTIONS` only applies to unassigned sections.
  { id: "settings", label: null, sections: ["profile"] },
  { id: "home", label: null, sections: rowIds("admin", "dashboard", "communication") },
  { id: "property-management", label: "Property management", sections: rowIds("admin", "property") },
  { id: "software", label: "Software", sections: rowIds("admin", "accounts", "money", "growth") },
];

// Manager, resident and vendor rows carry no heading of their own: a row IS the group (the folds above).
const PRO_GROUPS: NavGroupConfig[] = [{ id: "main", label: null, sections: rowSections("pro", PRO_ROW_ORDER) }];
const RESIDENT_GROUPS: NavGroupConfig[] = [
  { id: "main", label: null, sections: rowSections("resident", RESIDENT_ROW_ORDER) },
];
const VENDOR_GROUPS: NavGroupConfig[] = [{ id: "main", label: null, sections: rowSections("vendor", VENDOR_ROW_ORDER) }];

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
