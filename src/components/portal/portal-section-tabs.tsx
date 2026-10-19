"use client";

import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";
import { buildPortalNavItems } from "@/components/portal/portal-nav-model";
import type { ManagerPortalNavTier } from "@/lib/manager-access";
import { isSectionListPath, navSectionTabsFor } from "@/lib/portals/nav-groups";
import { portalNavLockKind } from "@/lib/portals/nav-locks";
import {
  residentNavLockReason,
  residentNavSectionVisibleInNav,
  type ResidentPortalNavStage,
} from "@/lib/resident-portal-nav";
import type { PortalDefinition } from "@/lib/portal-types";

/**
 * The portal section shown by the URL, only when the URL is the LIST level of that section
 * (`/portal/leases/signed`, `/admin/health`): a record under it (`/portal/vendors/<id>`,
 * `/admin/axis-users/<id>`) keeps the record-page chrome and carries no strip.
 */
function sectionOnListPath(pathname: string | null, definition: PortalDefinition): string | null {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  const base = definition.basePath.split("/").filter(Boolean);
  if (parts.length < base.length + 1 || base.some((seg, i) => parts[i] !== seg)) return null;
  const rest = parts.slice(base.length);
  return isSectionListPath(rest) ? rest[0]! : null;
}

function SectionTabStrip({
  definition,
  section,
  groupSections,
  label,
  subscriptionTier,
  residentNavStage,
  smsUiEnabled,
}: {
  definition: PortalDefinition;
  section: string;
  groupSections: string[];
  label: string;
  subscriptionTier?: ManagerPortalNavTier | null;
  residentNavStage?: ResidentPortalNavStage;
  smsUiEnabled?: boolean;
}) {
  const counts = usePortalNavCounts(definition.kind, smsUiEnabled);
  const hrefs = useMemo(
    () =>
      new Map(
        buildPortalNavItems(definition, definition.sections, false, residentNavStage).map((item) => [
          item.section,
          item.href,
        ]),
      ),
    [definition, residentNavStage],
  );
  const items: DestinationNavItem[] = groupSections.map((id) => {
    const lock = portalNavLockKind({
      kind: definition.kind,
      section: id,
      subscriptionTier: subscriptionTier ?? undefined,
      residentNavStage,
    });
    const tabLabel = definition.sections.find((s) => s.section === id)?.label ?? id;
    const locked = lock !== "none";
    const reason =
      locked && definition.kind === "resident" && residentNavStage
        ? residentNavLockReason(id, residentNavStage)
        : null;
    const count = counts[id]?.count ?? 0;
    return {
      id,
      label: tabLabel,
      href: hrefs.get(id) ?? `${definition.basePath}/${id}`,
      dataAttr: `section-tab-${id}`,
      locked,
      inert: lock === "inert",
      lockLabel: locked
        ? definition.kind === "resident"
          ? `${tabLabel}: ${reason ?? "unavailable on your property's Free plan"}`
          : `${tabLabel}: locked on Pro or Business`
        : undefined,
      count: !locked && count > 0 ? count : undefined,
      alert: !locked && counts[id]?.tone === "alert" && count > 0,
    };
  });
  return (
    <div className="mb-3 min-w-0 max-w-full" data-attr="portal-section-tabs" data-portal-section-tabs data-fold-section={section}>
      <DestinationNav items={items} activeId={section} ariaLabel={label} appearance="command" />
    </div>
  );
}

/**
 * The strip along the top of every page in a folded sidebar row (portal simplification, Oct 18): Money shows
 * Incoming · Outgoing · Finances · Documents, Leasing shows Tours · Applications · Leases · Forms. Every tab is
 * a real link to its own section, so URLs, handlers and deep links are exactly what they were; a tab locked by
 * plan or lifecycle stage shows a padlock on its own (the row is the upgrade entry point, never a whole row
 * hidden behind a sibling's lock). Section lists and the fold live in `nav-groups.ts` (`NAV_FOLDS`).
 */
export function PortalSectionTabs({
  definition,
  subscriptionTier,
  residentNavStage,
  smsUiEnabled,
}: {
  definition: PortalDefinition;
  subscriptionTier?: ManagerPortalNavTier | null;
  residentNavStage?: ResidentPortalNavStage;
  smsUiEnabled?: boolean;
}) {
  const pathname = usePathname();
  const section = sectionOnListPath(pathname, definition);
  if (!section) return null;
  const available = definition.sections
    .map((s) => s.section)
    .filter(
      (id) =>
        definition.kind !== "resident" ||
        !residentNavStage ||
        residentNavSectionVisibleInNav(id, residentNavStage),
    );
  const group = navSectionTabsFor(definition.kind, section, available);
  if (!group) return null;
  return (
    <SectionTabStrip
      definition={definition}
      section={section}
      groupSections={group.sections}
      label={group.label}
      subscriptionTier={subscriptionTier}
      residentNavStage={residentNavStage}
      smsUiEnabled={smsUiEnabled}
    />
  );
}
