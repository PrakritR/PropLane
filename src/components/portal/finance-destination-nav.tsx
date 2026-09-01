"use client";

import Link from "next/link";
import { HORIZONTAL_SCROLL_ATTR, PORTAL_HORIZONTAL_SCROLL_ROW_CLASS } from "@/lib/horizontal-scroll";
import { cn } from "@/lib/utils";

export const FINANCE_NAV_TAB_IDS = [
  "income",
  "expenses",
  "trial-balance",
  "balance-sheet",
  "general-ledger",
  "cash-flow-statement",
  "payout-history",
  "trust-account-balance",
  "security-deposits",
  "financial-diagnostics",
  "ap-aging",
  "bills",
  "budget-vs-actual",
  "bank-reconciliation",
  "owner-statement",
  "owner-distributions",
] as const;

type FinanceTabItem = { id: string; label: string; href: string };

const FINANCE_NAV_LINK_CLASS =
  "block rounded-lg px-3 py-2 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150";

/**
 * One flat list of finance views — no Transactions/Reports/Operations tiers.
 * Desktop: left rail; mobile: horizontal scroll above the active panel.
 */
export function FinanceDestinationNav({
  tabId,
  tabItems,
}: {
  tabId: string;
  tabItems: FinanceTabItem[];
}) {
  const orderedItems = FINANCE_NAV_TAB_IDS.map((id) => tabItems.find((item) => item.id === id)).filter(
    (item): item is FinanceTabItem => Boolean(item),
  );
  const items = orderedItems.length > 0 ? orderedItems : tabItems;

  return (
    <>
      <nav className="hidden min-w-[11.5rem] shrink-0 flex-col gap-0.5 lg:flex" aria-label="Finance views">
        {items.map((item) => {
          const active = item.id === tabId;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                FINANCE_NAV_LINK_CLASS,
                active
                  ? "bg-[var(--secondary)] text-foreground"
                  : "text-muted hover:bg-[var(--secondary)]/60 hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <nav
        className={cn(PORTAL_HORIZONTAL_SCROLL_ROW_CLASS, "flex gap-1 border-b border-border pb-2 lg:hidden")}
        aria-label="Finance views"
        {...{ [HORIZONTAL_SCROLL_ATTR]: "" }}
      >
        {items.map((item) => {
          const active = item.id === tabId;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                "shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
