"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ChevronDown, Minus, Plus, X } from "lucide-react";

import type { RecordSectionGroup } from "@/lib/portals/record-sections";
import { cn } from "@/lib/utils";

/**
 * The phone section dropdown (PLAN-0921-1029, area 1): replaces the
 * horizontal chip strip. Closed: one full-width row showing the current
 * section with a "Sections ⌄" affordance. Open: every section from the
 * registry's groups as a row — a labeled group with more than one item shows
 * `+`, which expands its items inline (`−` collapses) without navigating; any
 * other row navigates and closes the picker. A trailing "Close" row closes
 * without navigating. A disclosure + list of links: keyboard-operable,
 * `aria-expanded` on both the picker and any expanded group.
 */
export function PortalRecordSectionPicker({
  groups,
  recordId,
  activeId,
  ariaLabel,
}: {
  groups: RecordSectionGroup[];
  recordId: string;
  activeId?: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listId = useId();

  const flatGroups = groups.filter((group) => group.items.length > 0);
  const active = flatGroups.flatMap((group) => group.items).find((item) => item.id === activeId);

  if (flatGroups.length === 0) return null;

  function toggleGroup(label: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <div className="lg:hidden" data-attr="record-section-picker">
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between rounded-xl border border-border bg-card px-4 text-[14.5px] font-semibold text-foreground"
        aria-expanded={open}
        aria-controls={listId}
        data-attr="record-section-picker-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{active?.label ?? "Sections"}</span>
        <span className="ml-2 inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold text-muted">
          Sections
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
        </span>
      </button>
      {open ? (
        <nav id={listId} aria-label={ariaLabel} className="mt-1.5 overflow-hidden rounded-xl border border-border bg-card">
          {flatGroups.map((group) => {
            const isExpandableGroup = group.label && group.items.length > 1;
            if (!isExpandableGroup) {
              return group.items.map((item) => (
                <Link
                  key={item.id}
                  href={item.href(recordId)}
                  aria-current={item.id === activeId ? "page" : undefined}
                  data-attr={`record-section-picker-item-${item.id}`}
                  className={cn(
                    "flex min-h-11 items-center gap-2 border-b border-border/70 px-4 py-2.5 text-[14px] font-medium last:border-b-0",
                    item.id === activeId ? "bg-accent/50 text-primary" : "text-foreground hover:bg-accent/30",
                  )}
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              ));
            }
            const groupOpen = expanded.has(group.label);
            return (
              <div key={group.label} className="border-b border-border/70 last:border-b-0">
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-[14px] font-medium text-foreground hover:bg-accent/30"
                  aria-expanded={groupOpen}
                  data-attr={`record-section-picker-group-${group.label}`}
                  onClick={() => toggleGroup(group.label)}
                >
                  {group.label}
                  {groupOpen ? (
                    <Minus className="size-4 shrink-0 text-muted" aria-hidden />
                  ) : (
                    <Plus className="size-4 shrink-0 text-muted" aria-hidden />
                  )}
                </button>
                {groupOpen ? (
                  <div className="bg-[var(--secondary)]/40">
                    {group.items.map((item) => (
                      <Link
                        key={item.id}
                        href={item.href(recordId)}
                        aria-current={item.id === activeId ? "page" : undefined}
                        data-attr={`record-section-picker-item-${item.id}`}
                        className={cn(
                          "flex min-h-11 items-center gap-2 border-t border-border/70 py-2.5 pl-8 pr-4 text-[13.5px] font-medium",
                          item.id === activeId ? "text-primary" : "text-foreground hover:bg-accent/30",
                        )}
                        onClick={() => setOpen(false)}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-center gap-1.5 px-4 py-2.5 text-[13px] font-semibold text-muted hover:bg-accent/30"
            data-attr="record-section-picker-close"
            onClick={() => setOpen(false)}
          >
            <X className="size-3.5" aria-hidden />
            Close
          </button>
        </nav>
      ) : null}
    </div>
  );
}
