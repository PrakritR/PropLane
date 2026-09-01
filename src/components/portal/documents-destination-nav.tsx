"use client";

import Link from "next/link";
import { HORIZONTAL_SCROLL_ATTR, PORTAL_HORIZONTAL_SCROLL_ROW_CLASS } from "@/lib/horizontal-scroll";
import { cn } from "@/lib/utils";

export const DOCUMENT_NAV_TAB_IDS = [
  "applications",
  "leases",
  "income-documents",
  "expense-documents",
  "library",
  "templates",
  "occupancy",
  "1099",
  "tax-summary",
] as const;

type DocumentTabItem = { id: string; label: string; href: string };

const DOCUMENT_NAV_LINK_CLASS =
  "block rounded-lg px-3 py-2 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150";

/**
 * One flat list of document views — no Files/Leasing/Reports grouping. On
 * desktop the list sits in a left rail; on phones it scrolls horizontally above
 * the active panel.
 */
export function DocumentsDestinationNav({
  tabId,
  tabItems,
}: {
  tabId: string;
  tabItems: DocumentTabItem[];
}) {
  const orderedItems = DOCUMENT_NAV_TAB_IDS.map((id) => tabItems.find((item) => item.id === id)).filter(
    (item): item is DocumentTabItem => Boolean(item),
  );
  const items = orderedItems.length > 0 ? orderedItems : tabItems;

  return (
    <>
      <nav
        className={cn(
          "hidden min-w-[11.5rem] shrink-0 flex-col gap-0.5 lg:flex",
        )}
        aria-label="Document types"
      >
        {items.map((item) => {
          const active = item.id === tabId;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                DOCUMENT_NAV_LINK_CLASS,
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
        className={cn(
          PORTAL_HORIZONTAL_SCROLL_ROW_CLASS,
          "flex gap-1 border-b border-border pb-2 lg:hidden",
        )}
        aria-label="Document types"
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
