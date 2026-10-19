"use client";

import { usePathname } from "next/navigation";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { ownerMoneyTabForPath, ownerMoneyTabs, OWNER_BASE_PATH } from "@/lib/property-owner/sections";

/**
 * The strip along the top of every page in the Money row: Statements · Finances · Documents. Every tab is a real link to its own
 * page, as a self-contained strip (no dependency on the shared nav folds). It shows on the LIST level of a tab only; a statement
 * month opened from the list keeps its own record header and carries no strip.
 */
export function OwnerSectionTabs({ financesOn }: { financesOn: boolean }) {
  const pathname = usePathname() ?? "";
  const active = ownerMoneyTabForPath(pathname);
  if (!active) return null;
  const rest = pathname.split("?")[0]!.replace(/\/+$/, "").slice(OWNER_BASE_PATH.length).replace(/^\//, "").split("/");
  if (rest.length > 1) return null;
  const items: DestinationNavItem[] = ownerMoneyTabs(financesOn).map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: tab.href,
    dataAttr: `owner-tab-${tab.id}`,
  }));
  return (
    <div className="mb-3 min-w-0 max-w-full shrink-0" data-attr="owner-section-tabs">
      <DestinationNav items={items} activeId={active} ariaLabel="Money" appearance="command" />
    </div>
  );
}
