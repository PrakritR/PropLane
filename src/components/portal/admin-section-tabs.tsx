"use client";

import { usePathname } from "next/navigation";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";
import { adminSectionTabsFor } from "@/lib/portals/nav-groups";
import type { PortalDefinition } from "@/lib/portal-types";

/**
 * The admin section currently shown, only when the URL is the section's own
 * page (`/admin/<section>`): a record under it (`/admin/axis-users/<id>`) keeps
 * the record-page chrome and carries no strip.
 */
function adminSectionOnRoot(pathname: string | null): string | null {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  if (parts[0] !== "admin" || parts.length !== 2) return null;
  return parts[1] ?? null;
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
  const section = adminSectionOnRoot(pathname);
  if (!section) return null;
  const group = adminSectionTabsFor(
    section,
    definition.sections.map((s) => s.section),
  );
  if (!group) return null;
  const items: DestinationNavItem[] = group.sections.map((id) => ({
    id,
    label: definition.sections.find((s) => s.section === id)?.label ?? id,
    href: `${definition.basePath}/${id}`,
    dataAttr: `admin-tab-${id}`,
  }));
  if (group.groupId === "support") {
    return <SupportTabCounts items={items} activeId={section} label={group.label} />;
  }
  return <AdminTabStrip items={items} activeId={section} label={group.label} />;
}
