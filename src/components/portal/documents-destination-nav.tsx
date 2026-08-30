"use client";

import { DestinationNav } from "@/components/ui/destination-nav";

/** Keeps nine document views out of one overflowing tab row. */
export const DOCUMENT_NAV_GROUPS = [
  {
    id: "files",
    label: "Files",
    tabIds: ["library", "templates"],
  },
  {
    id: "leasing",
    label: "Leasing",
    tabIds: ["applications", "leases"],
  },
  {
    id: "reports",
    label: "Reports",
    tabIds: ["income-documents", "expense-documents", "occupancy", "1099", "tax-summary"],
  },
] as const;

export function documentGroupIdForTab(tabId: string): string {
  for (const group of DOCUMENT_NAV_GROUPS) {
    if ((group.tabIds as readonly string[]).includes(tabId)) return group.id;
  }
  return DOCUMENT_NAV_GROUPS[0].id;
}

type DocumentTabItem = { id: string; label: string; href: string };

const DOCUMENT_GROUP_NAV_CLASS =
  "gap-2 border-b border-border px-0 [&_a]:min-h-9 [&_a]:px-3 max-lg:scroll-px-0";

const DOCUMENT_VIEW_NAV_CLASS =
  "max-w-none rounded-xl border border-border bg-accent/30 p-1 [&_a]:!flex-none [&_a]:!basis-auto max-lg:rounded-xl max-lg:border max-lg:bg-accent/30";

/**
 * Two-tier document navigation: category labels establish context; the compact
 * contextual row switches views. Equal-width button grids made both levels
 * look like primary actions and overwhelmed the document list.
 */
export function DocumentsDestinationNav({
  tabId,
  tabItems,
}: {
  tabId: string;
  tabItems: DocumentTabItem[];
}) {
  const activeGroupId = documentGroupIdForTab(tabId);
  const activeGroup = DOCUMENT_NAV_GROUPS.find((group) => group.id === activeGroupId) ?? DOCUMENT_NAV_GROUPS[0];
  const subItems = tabItems.filter((item) => (activeGroup.tabIds as readonly string[]).includes(item.id));

  const groupItems = DOCUMENT_NAV_GROUPS.map((group) => {
    const targetTab = (group.tabIds as readonly string[]).includes(tabId) ? tabId : group.tabIds[0];
    const href = tabItems.find((item) => item.id === targetTab)?.href ?? tabItems[0]?.href ?? "";
    return {
      id: group.id,
      label: group.label,
      href,
    };
  });

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <DestinationNav
        items={groupItems}
        activeId={activeGroupId}
        ariaLabel="Document section"
        appearance="command"
        className={DOCUMENT_GROUP_NAV_CLASS}
      />
      {subItems.length > 0 ? (
        <DestinationNav
          items={subItems}
          activeId={tabId}
          ariaLabel="Document view"
          size="toolbar"
          className={DOCUMENT_VIEW_NAV_CLASS}
        />
      ) : null}
    </div>
  );
}
