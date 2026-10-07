import {
  residentNavSectionVisibleInNav,
  type ResidentPortalNavStage,
} from "@/lib/resident-portal-nav";
import { PAYMENT_BUCKETS } from "@/lib/portal-detail-routes";
import { isAppNavHiddenInNativeShell } from "@/lib/portals/nav-groups";
import type { PortalDefinition } from "@/lib/portal-types";

/**
 * The portal's sidebar rows as data, shared by the sidebar, the top strip's
 * command palette and the tests. Nothing here renders; it only decides which
 * sections exist, where each one links, and what to prefetch.
 */

export function hrefForSection(def: PortalDefinition, section: string) {
  const meta = def.sections.find((s) => s.section === section);
  if (!meta) return def.basePath;
  if (section === "communication") {
    if (def.basePath === "/portal" || def.basePath === "/resident" || def.basePath === "/vendor") {
      return `${def.basePath}/communication/active`;
    }
    return `${def.basePath}/communication`;
  }
  if (!meta.tabs.length) return `${def.basePath}/${section}`;
  // Most tabbed sections use `/section/tab` only. Bucketed queues (applications,
  // tours, payments) declare `tabs: []` in the registry and own their own href
  // builders — do not append `/pending` here or Finances/Documents 404.
  if (section === "tasks") return `${def.basePath}/tasks`;
  return `${def.basePath}/${section}/${meta.tabs[0].id}`;
}

export type PortalSidebarNavSubItem = {
  sectionTabId: string;
  label: string;
  href: string;
  prefetchHrefs: string[];
};

export type PortalSidebarNavItem = {
  section: string;
  label: string;
  href: string;
  prefetchHrefs: string[];
  sectionTabId?: string;
  subItems?: PortalSidebarNavSubItem[];
};

export function buildPortalNavItems(
  definition: PortalDefinition,
  visibleSections: PortalDefinition["sections"],
  showNativeChrome: boolean,
  residentNavStage: ResidentPortalNavStage | undefined,
): PortalSidebarNavItem[] {
  return visibleSections
    .filter((section) => {
      if (isAppNavHiddenInNativeShell(definition.kind, section.section, showNativeChrome)) {
        return false;
      }
      if (
        definition.kind === "resident" &&
        residentNavStage &&
        !residentNavSectionVisibleInNav(section.section, residentNavStage)
      ) {
        return false;
      }
      return true;
    })
    .flatMap((section) => {
      if (
        section.section === "payments" &&
        section.tabs.some((tab) => tab.id === "incoming" || tab.id === "outgoing")
      ) {
        const tabs = section.tabs.filter((tab) => tab.id === "incoming" || tab.id === "outgoing");
        return [
          {
            section: section.section,
            label: section.label,
            href: `${definition.basePath}/payments/incoming/pending`,
            prefetchHrefs: PAYMENT_BUCKETS.flatMap((bucket) =>
              tabs.map((tab) => `${definition.basePath}/payments/${tab.id}/${bucket}`),
            ),
            subItems: tabs.map((tab) => ({
              sectionTabId: tab.id,
              label: tab.label,
              href: `${definition.basePath}/payments/${tab.id}/pending`,
              prefetchHrefs: PAYMENT_BUCKETS.map(
                (bucket) => `${definition.basePath}/payments/${tab.id}/${bucket}`,
              ),
            })),
          },
        ];
      }
      if (definition.kind === "vendor" && section.section === "financials" && section.tabs.length > 1) {
        // Finances (vendor-banking-1006): Balance & payouts · Payments · Refunds ·
        // Statements · Tax info nest under the one Finances row, like manager Payments.
        return [
          {
            section: section.section,
            label: section.label,
            href: `${definition.basePath}/financials/${section.tabs[0]!.id}`,
            prefetchHrefs: section.tabs.map((tab) => `${definition.basePath}/financials/${tab.id}`),
            subItems: section.tabs.map((tab) => ({
              sectionTabId: tab.id,
              label: tab.label,
              href: `${definition.basePath}/financials/${tab.id}`,
              prefetchHrefs: [`${definition.basePath}/financials/${tab.id}`],
            })),
          },
        ];
      }
      if (section.section === "applications") {
        // Screening nests inside the application record's own Screening tab now
        // (docs/agents/record-page.md, PLAN-0920-1058 area 1c) — no second
        // sidebar sub-item for it.
        const appBase = `${definition.basePath}/applications/pending`;
        return [
          {
            section: section.section,
            label: section.label,
            href: appBase,
            prefetchHrefs: [appBase],
          },
        ];
      }
      const tabPrefetchHrefs =
        section.tabs.length > 0
          ? section.tabs.map((tab) => `${definition.basePath}/${section.section}/${tab.id}`)
          : [`${definition.basePath}/${section.section}`];
      return [
        {
          section: section.section,
          label: section.label,
          href: hrefForSection(definition, section.section),
          prefetchHrefs: tabPrefetchHrefs,
        },
      ];
    });
}

