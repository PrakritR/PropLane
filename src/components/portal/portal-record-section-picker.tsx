"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ChevronDown, X } from "lucide-react";

import type { RecordSectionGroup } from "@/lib/portals/record-sections";
import { cn } from "@/lib/utils";

/**
 * Phone section menu. Closed: the current section and a chevron. Open: every
 * group label, then its sections, always listed. Tapping a section navigates
 * and closes. Close dismisses the menu.
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
  const listId = useId();

  const flatGroups = groups.filter((group) => group.items.length > 0);
  const active = flatGroups.flatMap((group) => group.items).find((item) => item.id === activeId);

  if (flatGroups.length === 0) return null;

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
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <nav id={listId} aria-label={ariaLabel} className="mt-1.5 overflow-hidden rounded-xl border border-border bg-card">
          {flatGroups.map((group) => (
            <div key={group.label || group.items[0]?.id}>
              {group.label ? (
                <div
                  className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"
                  data-attr={`record-section-picker-group-${group.label}`}
                >
                  {group.label}
                </div>
              ) : null}
              {group.items.map((item) => (
                <Link
                  key={item.id}
                  href={item.href(recordId)}
                  aria-current={item.id === activeId ? "page" : undefined}
                  data-attr={`record-section-picker-item-${item.id}`}
                  className={cn(
                    "flex min-h-11 items-center gap-2 border-b border-border/70 px-4 py-2.5 text-[14px] font-medium last:border-b-0",
                    item.id === activeId ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/30",
                  )}
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
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
