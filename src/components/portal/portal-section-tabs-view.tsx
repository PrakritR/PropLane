"use client";

import { DestinationNav, LocalDestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";

/** The shared folded-section strip. Fixture previews use local callbacks instead of route links. */
export function PortalSectionTabsView({ items, section, label, onChange }: {
  items: DestinationNavItem[];
  section: string;
  label: string;
  onChange?: (section: string) => void;
}) {
  return <div className="mb-3 min-w-0 max-w-full shrink-0" data-attr="portal-section-tabs" data-portal-section-tabs data-fold-section={section}>
    {onChange
      ? <LocalDestinationNav items={items} activeId={section} ariaLabel={label} appearance="command" onChange={onChange} />
      : <DestinationNav items={items} activeId={section} ariaLabel={label} appearance="command" />}
  </div>;
}
