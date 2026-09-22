"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A group header's footer line, under its rows: one fact, or two side by
 * side ("Paid this year · $16,200", "Next rent posts Oct 25"). A list that
 * can only prove one of the two facts renders that one alone rather than
 * inventing the other.
 */
export type PortalListGroupFooter = readonly [string] | readonly [string, string];

/**
 * True while a row renders inside a `PortalListGroup`'s rows slot. Every
 * list-row shell built on `PortalPropertyRecordRow` reads this
 * (`usePortalListGroupFlushRow`) to drop its own card chrome — margin,
 * border, rounded corners, shadow — so the group reads as ONE container:
 * the header at the top, its rows inside it separated by hairlines, and the
 * group's footer at the bottom. Collapsing the group hides the whole rows
 * slot at once. A row rendered outside any group (Group = None, or a list
 * that has not adopted grouping) sees the default `false` and keeps its own
 * card, unchanged.
 */
export const PortalListGroupRowContext = createContext(false);

/** Whether the nearest `PortalListGroup` wants its rows flush — see `PortalListGroupRowContext`. */
export function usePortalListGroupFlushRow(): boolean {
  return useContext(PortalListGroupRowContext);
}

function collapsedStorageKey(listKey: string, groupKey: string): string {
  return `portal-list-group-collapsed:${listKey}:${groupKey}`;
}

function readStoredCollapsed(listKey: string, groupKey: string): boolean | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(collapsedStorageKey(listKey, groupKey));
    return raw == null ? null : raw === "1";
  } catch {
    return null;
  }
}

function writeStoredCollapsed(listKey: string, groupKey: string, collapsed: boolean): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(collapsedStorageKey(listKey, groupKey), collapsed ? "1" : "0");
  } catch {
    // Private mode / blocked storage — the group just reopens next visit.
  }
}

/**
 * The group header every grouped list shares (`docs/agents/record-page.md`
 * "Lists"): an optional round avatar, the group's name, one sub-line, and a
 * right-hand summary (a bold figure plus a muted count) — whether the group
 * is a person, a property, or a period. Collapsible; the choice is
 * remembered per list, per group, per viewer. An optional footer line
 * renders under the group's rows.
 *
 * The whole group — header, rows, footer — is ONE card: a single bordered,
 * rounded, shadowed container, with the header separated from its rows by a
 * hairline and each row separated from the next by a hairline
 * (`PortalListGroupRowContext` is what makes the individual rows render
 * flush instead of floating as their own cards).
 */
export function PortalListGroup({
  listKey,
  groupKey,
  name,
  sub,
  avatar,
  figure,
  count,
  footer,
  defaultCollapsed = false,
  dataAttr,
  children,
}: {
  /** Which list this group belongs to — scopes the remembered collapsed state. */
  listKey: string;
  /** Stable id for this group within the list — scopes the remembered collapsed state. */
  groupKey: string;
  name: string;
  sub?: string;
  /** Initials for a round avatar. Omit for a property/period group (no avatar). */
  avatar?: string;
  /** The bold right-hand figure ("$3,750 due", "2 open"). */
  figure?: string;
  /** The muted count beside the figure ("3 charges", "2 open"). */
  count?: string;
  footer?: PortalListGroupFooter;
  defaultCollapsed?: boolean;
  dataAttr?: string;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  useEffect(() => {
    const stored = readStoredCollapsed(listKey, groupKey);
    if (stored != null) setCollapsed(stored);
  }, [listKey, groupKey]);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeStoredCollapsed(listKey, groupKey, next);
      return next;
    });
  };

  const hasHeader = Boolean(name || avatar || figure || count);

  return (
    <div
      className="mb-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      data-attr={dataAttr ?? "portal-list-group"}
      data-group-key={groupKey}
    >
      {hasHeader ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left"
          data-attr="portal-list-group-header"
        >
          {avatar ? (
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/[0.08] text-[12px] font-bold text-primary"
            >
              {avatar}
            </span>
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold text-foreground">{name}</span>
            {sub ? <span className="block truncate text-[12px] text-muted">{sub}</span> : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {figure || count ? (
              <span className="flex flex-col items-end leading-tight">
                {figure ? <b className="text-[13px] font-bold text-foreground">{figure}</b> : null}
                {count ? <span className="text-[11px] text-muted">{count}</span> : null}
              </span>
            ) : null}
            <ChevronDown
              className={cn("size-4 shrink-0 text-muted transition-transform", collapsed && "-rotate-90")}
              aria-hidden
            />
          </span>
        </button>
      ) : null}
      {collapsed ? null : (
        <div className={cn(hasHeader && "border-t border-border/60")}>
          <PortalListGroupRowContext.Provider value={true}>
            <div className="divide-y divide-border/60">{children}</div>
          </PortalListGroupRowContext.Provider>
          {footer ? (
            <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-[11px] text-muted">
              <span className="truncate">{footer[0]}</span>
              {footer[1] ? <span className="truncate">{footer[1]}</span> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
