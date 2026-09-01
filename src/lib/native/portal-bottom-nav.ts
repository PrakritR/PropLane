import type { PortalDefinition } from "@/lib/portal-types";
import {
  residentBottomNavPrimarySections,
  type ResidentPortalNavStage,
} from "@/lib/resident-portal-nav";

/** Settings tab — always pinned to the end of the native bottom bar. */
const SETTINGS_SECTION = "profile";

/** @deprecated All sections scroll in the native bar; kept for compatibility. */
export const NATIVE_BOTTOM_NAV_PRIMARY_LIMIT = 7;

/** @deprecated Use {@link NATIVE_BOTTOM_NAV_PRIMARY_LIMIT}. */
export const NATIVE_BOTTOM_NAV_SLOT_LIMIT = NATIVE_BOTTOM_NAV_PRIMARY_LIMIT;

/**
 * Manager / pro footer order — mirrors `proPortal.sections` (Settings omitted; pinned last in the bar).
 * Keep in sync with `src/lib/portals/pro.ts`.
 */
export const NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER = [
  "dashboard",
  "properties",
  "tours",
  "applications",
  "leases",
  "residents",
  "payments",
  "services",
  "tasks",
  "calendar",
  "bookings",
  "communication",
  "teams",
  "promotion",
  "financials",
  "documents",
  "bugs-feedback",
  "app",
] as const;

/**
 * Resident footer order — mirrors resident portal registries (Settings omitted; pinned last).
 * Keep in sync with `src/lib/portals/resident-sections.ts`.
 */
export const NATIVE_BOTTOM_NAV_RESIDENT_ORDER = [
  "tour",
  "applications",
  "dashboard",
  "lease",
  "services",
  "payments",
  "communication",
  "move-in",
  "documents",
] as const;

/**
 * Vendor footer order — mirrors `vendorPortal.sections` (Settings/profile omitted; pinned last).
 * Keep in sync with `src/lib/portals/vendor.ts`.
 */
export const NATIVE_BOTTOM_NAV_VENDOR_ORDER = [
  "dashboard",
  "work-orders",
  "tasks",
  "calendar",
  "bookings",
  "communication",
  "financials",
  "payments",
  "documents",
] as const;

/**
 * Native bottom bar order — preserves portal registry order (web sidebar = native bar).
 * Settings is always appended last when present.
 */
export function orderNativeBottomNavItems<T extends { section: string }>(
  items: T[],
  kind?: PortalDefinition["kind"],
): T[] {
  if (items.length === 0) return [];

  const settings = items.find((item) => item.section === SETTINGS_SECTION);
  const rest = items.filter((item) => item.section !== SETTINGS_SECTION);

  if (kind === "resident") {
    const bySection = new Map(rest.map((item) => [item.section, item]));
    const ordered = NATIVE_BOTTOM_NAV_RESIDENT_ORDER.map((section) => bySection.get(section)).filter(
      (item): item is T => Boolean(item),
    );
    const orderedSet = new Set(ordered.map((item) => item.section));
    const trailing = rest.filter((item) => !orderedSet.has(item.section));
    const body = [...ordered, ...trailing];
    if (settings) return [...body, settings];
    return body;
  }

  if (settings) return [...rest, settings];
  return [...items];
}

/**
 * Curated primary sets for the fixed native bottom bar — one screen's worth of
 * one-tap tabs per role. Everything else in the portal registry is still reachable
 * via the swipe-up "More" sheet (which now lists every section, primary or not —
 * see `moreSheetItems` in portal-sidebar.tsx) and/or nested inside the most
 * relevant primary tab's own page (Promotion + Co-managers inside Properties;
 * Feedback inside Profile/Settings — see portal-settings-extras.tsx and
 * manager-properties.tsx). Keep in sync with `src/lib/platform/parity.ts`.
 */
export const NATIVE_BOTTOM_NAV_PRO_MANAGER_PRIMARY = [
  "properties",
  "residents",
  "dashboard",
  "communication",
] as const;

/**
 * Resident primary sets are DERIVED from `RESIDENT_BOTTOM_NAV_PRIMARY`, the one
 * stage→tabs table `primaryOrderFor` actually reads. They were literal copies,
 * so the table could change while these — and the tests asserting against
 * them — kept describing a bar that no longer shipped.
 */
export const NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY =
  residentBottomNavPrimarySections("pre_approval");

/** @deprecated Use NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY */
export const NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPLICATION_PRIMARY = NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY;

/** Application approved — lease not yet fully signed. */
export const NATIVE_BOTTOM_NAV_RESIDENT_POST_APPROVAL_PRIMARY =
  residentBottomNavPrimarySections("post_approval_pre_lease");

/** @deprecated Use NATIVE_BOTTOM_NAV_RESIDENT_POST_APPROVAL_PRIMARY */
export const NATIVE_BOTTOM_NAV_RESIDENT_PRE_LEASE_PRIMARY = NATIVE_BOTTOM_NAV_RESIDENT_POST_APPROVAL_PRIMARY;

/** Post-lease (both parties signed). */
export const NATIVE_BOTTOM_NAV_RESIDENT_PRIMARY = residentBottomNavPrimarySections("post_lease");

export const NATIVE_BOTTOM_NAV_ADMIN_PRIMARY = ["dashboard", "properties", "axis-users", "events"] as const;

export const NATIVE_BOTTOM_NAV_VENDOR_PRIMARY = ["work-orders", "calendar", "communication", "payments"] as const;

/**
 * Every role gets the fixed native bottom bar. Settings stays in the profile
 * menu; Dashboard is on the manager/resident primary bar when curated above.
 */
export function nativeBottomBarEnabledForKind(_kind?: PortalDefinition["kind"]): boolean {
  return true;
}

/**
 * Whether the fixed bar also gets a trailing "More" tab that opens the full
 * section sheet. Kinds whose curated primary set — plus the shared back
 * arrow (Dashboard) and profile menu (Settings) — already reaches every
 * section don't need one. Vendor now has 7 sections — Documents is reachable via
 * the More sheet alongside the 4 primary tabs + back + profile.
 */
export function nativeBottomNavShowMoreTab(
  kind?: PortalDefinition["kind"],
  _items?: { section: string }[],
): boolean {
  if (kind === "resident") return true;
  return kind === "pro" || kind === "manager" || kind === "vendor";
}

function primaryOrderFor(
  kind?: PortalDefinition["kind"],
  residentNavStage?: ResidentPortalNavStage,
): readonly string[] {
  if (kind === "resident" && residentNavStage) {
    return residentBottomNavPrimarySections(residentNavStage);
  }
  switch (kind) {
    case "pro":
    case "manager":
      return NATIVE_BOTTOM_NAV_PRO_MANAGER_PRIMARY;
    case "resident":
      return NATIVE_BOTTOM_NAV_RESIDENT_PRIMARY;
    case "admin":
      return NATIVE_BOTTOM_NAV_ADMIN_PRIMARY;
    case "vendor":
      return NATIVE_BOTTOM_NAV_VENDOR_PRIMARY;
    default:
      return [];
  }
}

/**
 * Splits registry sections into the fixed native bar (`primary`, curated per role
 * above) and everything else (`overflow`, shown only in the swipe-up More sheet).
 */
export function splitNativeBottomNavItems<T extends { section: string }>(
  items: T[],
  kind?: PortalDefinition["kind"],
  residentNavStage?: ResidentPortalNavStage,
): { primary: T[]; overflow: T[] } {
  const ordered = orderNativeBottomNavItems(items, kind);
  const primaryOrder = primaryOrderFor(kind, residentNavStage);
  // Fail closed: an unrecognized role with no curated primary set must not dump
  // every section onto the fixed bar — everything goes to the More sheet instead.
  if (primaryOrder.length === 0) return { primary: [], overflow: ordered };

  const bySection = new Map(ordered.map((item) => [item.section, item]));
  const primary = primaryOrder
    .map((section) => bySection.get(section))
    .filter((item): item is T => Boolean(item));
  const primarySections = new Set(primary.map((item) => item.section));
  // Settings is always reached via the mobile profile menu, never the bar or More sheet.
  const overflow = ordered.filter(
    (item) =>
      !primarySections.has(item.section) &&
      item.section !== SETTINGS_SECTION &&
      (kind === "admin" || item.section !== "bugs-feedback"),
  );
  return { primary, overflow };
}

/** @deprecated Use splitNativeBottomNavItems — kept for tests. */
export function pickNativeBottomNavItems<T extends { section: string }>(
  items: T[],
  kind?: PortalDefinition["kind"],
): T[] {
  return orderNativeBottomNavItems(items, kind);
}
