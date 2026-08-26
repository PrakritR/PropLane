"use client";

import { DestinationNav } from "@/components/ui/destination-nav";
import {
  TEAM_SECTION_TAB_LABELS,
  TEAM_SECTION_TABS,
  teamSectionHref,
  type TeamSectionTabId,
} from "@/lib/portal-detail-routes";

export function ManagerTeamTabNav({
  activeTab,
  basePath = "/portal",
  className,
}: {
  activeTab: TeamSectionTabId;
  basePath?: string;
  className?: string;
}) {
  return (
    <DestinationNav
      items={TEAM_SECTION_TABS.map((id) => ({
        id,
        label: TEAM_SECTION_TAB_LABELS[id],
        href: teamSectionHref(basePath, id),
        dataAttr: `team-tab-${id}`,
      }))}
      activeId={activeTab}
      ariaLabel="Team views"
      itemLayout="equal"
      denseEqualRow
      className={className ?? "max-w-none"}
    />
  );
}
