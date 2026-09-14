"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The property's sections, as a list you can read.
 *
 * On a phone the nine destinations used to be a horizontal pill strip, and nine
 * pills do not fit in 390px — Lease, Services and Promotion sat off the right
 * edge behind a scroll almost nobody finds, which made three features invisible.
 * A vertical list fits all nine, has room to say what each one is for, and can
 * carry its own state.
 *
 * Three rules it follows, taken from the app the captain sent:
 *
 * 1. Every row says what it DOES, not just what it is called.
 * 2. A row you cannot use yet stays visible and says why. Hiding it would make
 *    the feature undiscoverable, which is the problem this screen already had.
 * 3. Waiting work is counted on the row, so the list answers "what needs me?"
 *    without opening anything.
 *
 * Desktop is untouched — it has the left rail, where a strip was never the
 * problem.
 */
export type PortalPropertySectionItem = {
  id: string;
  label: string;
  /** One line saying what this destination is for. */
  description?: string;
  href: string;
  dataAttr?: string;
  /** Items waiting behind this row; omitted or 0 shows nothing. */
  count?: number;
  /**
   * Why this row cannot be opened yet ("Not available when off market").
   * Present means the row renders dimmed and inert, never hidden.
   */
  unavailableReason?: string;
};

export function PortalPropertySectionList({
  items,
  activeId,
  className,
  ariaLabel = "Property sections",
}: {
  items: PortalPropertySectionItem[];
  activeId?: string;
  className?: string;
  ariaLabel?: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={ariaLabel}
      className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}
      data-attr="property-section-list"
    >
      <ul className="divide-y divide-border/70">
        {items.map((item) => {
          const unavailable = Boolean(item.unavailableReason);
          const active = item.id === activeId;
          const body = (
            <>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[14px] font-semibold leading-tight tracking-[-0.01em]",
                    unavailable ? "text-muted" : "text-foreground",
                  )}
                >
                  {item.label}
                </span>
                <span className="mt-0.5 block truncate text-[12px] leading-snug text-muted">
                  {item.unavailableReason ?? item.description}
                </span>
              </span>
              {!unavailable && item.count ? (
                <span
                  className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold tabular-nums text-primary"
                  aria-label={`${item.count} waiting`}
                >
                  {item.count}
                </span>
              ) : null}
              {unavailable ? null : (
                <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
              )}
            </>
          );
          return (
            <li key={item.id}>
              {unavailable ? (
                <span
                  className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5"
                  data-attr={item.dataAttr}
                  aria-disabled
                >
                  {body}
                </span>
              ) : (
                <Link
                  href={item.href}
                  data-attr={item.dataAttr}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-[52px] items-center gap-3 px-3.5 py-2.5 transition-colors",
                    "hover:bg-accent/50 focus-visible:outline-none focus-visible:bg-accent/60",
                    active && "bg-primary/[0.07]",
                  )}
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
