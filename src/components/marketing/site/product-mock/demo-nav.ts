/**
 * The home demo's sidebar, derived from the REAL portal nav (captain 2026-10-07: "the home dashboard
 * must be IDENTICAL to the real dashboard — same sidebar tabs"). There is no second list: the rows are
 * `buildPortalNavItems` over the real portal definitions (`proPortal`, the resident catalog,
 * `vendorPortal`), bucketed by the real `groupNavItems` / `PORTAL_NAV_GROUPS`. A section a portal adds,
 * renames or moves shows up here with no edit, and `tests/unit/home-demo-nav-parity.test.ts` fails if
 * the demo ever stops following it. A tab id IS the real section id (`move-in`, `work-orders`, `payments`).
 */

import { buildPortalNavItems, type PortalSidebarNavItem } from "@/components/portal/portal-nav-model";
import { groupNavItems } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { RESIDENT_PORTAL_BASE_PATH, RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { vendorPortal } from "@/lib/portals/vendor";
import type { PortalDefinition, PortalKind } from "@/lib/portal-types";

export type DemoPortal = "manager" | "resident" | "vendor";
export type DemoSubTab = { id: string; label: string };
export type DemoTab = {
  /** The real section id. */
  id: string;
  label: string;
  /** The real group's heading; none for the unheaded home group. */
  group?: string;
  /** The real group's id (`home`, `portfolio`, ...). */
  groupId?: string;
  /** A row the real sidebar nests (vendor Finances): drawn with the real chevron and sub-rows. */
  subItems?: DemoSubTab[];
};

const RESIDENT_DEFINITION: PortalDefinition = {
  kind: "resident",
  basePath: RESIDENT_PORTAL_BASE_PATH,
  title: "Resident Portal",
  accent: "blue",
  sections: RESIDENT_UNIFIED_PORTAL_SECTIONS,
};

const SOURCES: Record<DemoPortal, { kind: PortalKind; definition: PortalDefinition }> = {
  manager: { kind: "pro", definition: proPortal },
  resident: { kind: "resident", definition: RESIDENT_DEFINITION },
  vendor: { kind: "vendor", definition: vendorPortal },
};

/** The real sidebar's rows for one portal, in the real order, each carrying its real group. */
export function demoNavFor(portal: DemoPortal): DemoTab[] {
  const { kind, definition } = SOURCES[portal];
  const items: PortalSidebarNavItem[] = buildPortalNavItems(definition, definition.sections, false, undefined);
  return groupNavItems(kind, items).flatMap((group) =>
    group.items.map((item) => ({
      id: item.section,
      label: item.label,
      group: group.label ?? undefined,
      groupId: group.id,
      subItems: item.subItems?.map((sub) => ({ id: sub.sectionTabId, label: sub.label })),
    })),
  );
}

export const DEMO_TABS: Record<DemoPortal, DemoTab[]> = {
  manager: demoNavFor("manager"),
  resident: demoNavFor("resident"),
  vendor: demoNavFor("vendor"),
};
