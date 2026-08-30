"use client";

import { DestinationNav } from "@/components/ui/destination-nav";

/** Top-level finance areas — keeps the tab bar from cramming 16 views into one row. */
export const FINANCE_NAV_GROUPS = [
  {
    id: "transactions",
    label: "Transactions",
    tabIds: ["income", "expenses"],
  },
  {
    id: "reports",
    label: "Reports",
    tabIds: [
      "trial-balance",
      "balance-sheet",
      "general-ledger",
      "cash-flow-statement",
      "payout-history",
      "owner-statement",
      "financial-diagnostics",
      "ap-aging",
      "budget-vs-actual",
    ],
  },
  {
    id: "operations",
    label: "Operations",
    tabIds: ["trust-account-balance", "security-deposits", "bills", "bank-reconciliation", "owner-distributions"],
  },
] as const;

export function financeGroupIdForTab(tabId: string): string {
  for (const group of FINANCE_NAV_GROUPS) {
    if ((group.tabIds as readonly string[]).includes(tabId)) return group.id;
  }
  return FINANCE_NAV_GROUPS[0].id;
}

type FinanceTabItem = { id: string; label: string; href: string };

const FINANCE_GROUP_NAV_CLASS =
  "gap-2 border-b border-border px-0 [&_a]:min-h-9 [&_a]:px-3 max-lg:scroll-px-0";

const FINANCE_VIEW_NAV_CLASS =
  "max-w-none rounded-xl border border-border bg-accent/30 p-1 [&_a]:!flex-none [&_a]:!basis-auto max-lg:rounded-xl max-lg:border max-lg:bg-accent/30";

/**
 * Category navigation stays visually quiet; the contextual row carries the
 * actual finance view. This avoids turning every navigational choice into a
 * large, equal-width button.
 */
export function FinanceDestinationNav({
  tabId,
  tabItems,
}: {
  tabId: string;
  tabItems: FinanceTabItem[];
}) {
  const activeGroupId = financeGroupIdForTab(tabId);
  const subItems = tabItems.filter((item) => {
    const group = FINANCE_NAV_GROUPS.find((entry) => entry.id === activeGroupId) ?? FINANCE_NAV_GROUPS[0];
    return (group.tabIds as readonly string[]).includes(item.id);
  });

  const groupItems = FINANCE_NAV_GROUPS.map((group) => {
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
        ariaLabel="Finance section"
        appearance="command"
        className={FINANCE_GROUP_NAV_CLASS}
      />
      {subItems.length > 0 ? (
        <DestinationNav
          items={subItems}
          activeId={tabId}
          ariaLabel="Finance view"
          size="toolbar"
          className={FINANCE_VIEW_NAV_CLASS}
        />
      ) : null}
    </div>
  );
}
