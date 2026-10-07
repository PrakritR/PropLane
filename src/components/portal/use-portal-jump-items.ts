"use client";

import { useMemo } from "react";
import { buildPortalNavItems } from "@/components/portal/portal-nav-model";
import { useCoManagerNavSections } from "@/hooks/use-co-manager-nav-sections";
import { useNativeChrome } from "@/hooks/use-is-native-app";
import { usePortalSession } from "@/hooks/use-portal-session";
import { portalNavLockNavigable, portalNavSectionLocked } from "@/lib/portals/nav-locks";
import { groupNavItems } from "@/lib/portals/nav-groups";
import type { ResidentPortalNavStage } from "@/lib/resident-portal-nav";
import type { PortalDefinition } from "@/lib/portal-types";

export type PortalJumpItem = {
  section: string;
  label: string;
  href: string;
  /** The sidebar heading this row sits under (null for the unheaded home group). */
  group: string | null;
};

/**
 * The portal's sidebar sections, in sidebar order, that the command palette's
 * JUMP TO group can navigate to. It reads the same model and the same lock
 * rules as the sidebar itself: a section whose lock is `inert` (a resident
 * stage not reached yet) is omitted - it has no destination - while an upsell
 * or notice lock stays reachable, exactly like its sidebar row.
 */
export function usePortalJumpItems({
  definition,
  subscriptionTier,
  residentNavStage,
}: {
  definition: PortalDefinition;
  subscriptionTier?: "free" | "paid" | null;
  residentNavStage?: ResidentPortalNavStage;
}): PortalJumpItem[] {
  const session = usePortalSession();
  const showNativeChrome = useNativeChrome();
  const { sections, restrictedSections } = useCoManagerNavSections(definition, session.userId);

  return useMemo(() => {
    const navItems = buildPortalNavItems(definition, sections, showNativeChrome, residentNavStage);
    const out: PortalJumpItem[] = [];
    for (const group of groupNavItems(definition.kind, navItems)) {
      for (const item of group.items) {
        const lock = {
          kind: definition.kind,
          section: item.section,
          subscriptionTier,
          residentNavStage,
          coManagerRestricted: restrictedSections.has(item.section),
        };
        if (portalNavSectionLocked(lock) && !portalNavLockNavigable(lock)) continue;
        out.push({
          section: item.section,
          label: item.label,
          href: item.subItems?.length ? item.subItems[0]!.href : item.href,
          group: group.label,
        });
      }
    }
    return out;
  }, [definition, restrictedSections, residentNavStage, sections, showNativeChrome, subscriptionTier]);
}
