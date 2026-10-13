"use client";

import { usePathname } from "next/navigation";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";
import { hrefForSection } from "@/components/portal/portal-nav-model";
import { adminSectionTabsFor } from "@/lib/portals/nav-groups";
import type { PortalDefinition } from "@/lib/portal-types";

/**
 * The admin section currently shown, only when the URL is the section's own
 * page: `/admin/<section>`, or `/admin/<section>/<tab>` for one of the
 * section's OWN registry tabs — the pages `hrefForSection` links to. A record
 * under it (`/admin/axis-users/<id>`) keeps the record-page chrome and carries
 * no strip.
 */
function adminSectionOnRoot(pathname: string | null, definition: PortalDefinition): string | null {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  const base = definition.basePath.split("/").filter(Boolean);
  if (parts.length < base.length + 1 || base.some((seg, i) => parts[i] !== seg)) return null;
  const rest = parts.slice(base.length);
  const section = rest[0];
  if (!section) return null;
  if (rest.length === 1) return section;
  if (rest.length > 2) return null;
  const tabs = definition.sections.find((s) => s.section === section)?.tabs ?? [];
  return tabs.some((tab) => tab.id === rest[1]) ? section : null;
}

/** Support carries the Meetings and Feedback to-do counts on their tabs. */
function SupportTabCounts({
  items,
  activeId,
  label,
}: {
  items: DestinationNavItem[];
  activeId: string;
  label: string;
}) {
  const counts = usePortalNavCounts("admin");
  return (
    <AdminTabStrip
      label={label}
      activeId={activeId}
      items={items.map((item) => {
        const count = counts[item.id]?.count ?? 0;
        return count > 0 ? { ...item, count } : item;
      })}
    />
  );
}

function AdminTabStrip({ items, activeId, label }: { items: DestinationNavItem[]; activeId: string; label: string }) {
  return (
    <div className="mb-3 min-w-0 max-w-full" data-attr="admin-section-tabs" data-admin-section-tabs>
      <DestinationNav items={items} activeId={activeId} ariaLabel={label} appearance="command" />
    </div>
  );
}

/**
 * Properties-style underline tab strip for a grouped admin row (Accounts, Money,
 * Support). Every tab is a real link to its own section; nothing renders for
 * Dashboard, Communication, Properties or Growth. The tab list comes from the
 * definition the layout passes, so the operator-only Test accounts tab is absent
 * for everyone else.
 */
export function AdminSectionTabs({ definition }: { definition: PortalDefinition }) {
  const pathname = usePathname();
  const section = adminSectionOnRoot(pathname, definition);
  if (!section) return null;
  const group = adminSectionTabsFor(
    section,
    definition.sections.map((s) => s.section),
  );
  if (!group) return null;
  const items: DestinationNavItem[] = group.sections.map((id) => ({
    id,
    label: definition.sections.find((s) => s.section === id)?.label ?? id,
    href: hrefForSection(definition, id),
    dataAttr: `admin-tab-${id}`,
  }));
  if (group.groupId === "support") {
    return <SupportTabCounts items={items} activeId={section} label={group.label} />;
  }
  return <AdminTabStrip items={items} activeId={section} label={group.label} />;
}
