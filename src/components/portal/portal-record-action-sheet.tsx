"use client";

/**
 * A record's actions on a phone: one "Options" button at the foot of the
 * record, opening a bottom sheet with a grab handle and the actions as
 * full-width rows — the destructive one last, in red — the way iOS and Airbnb
 * present the choices a record offers. On desktop the caller renders its
 * inline action row instead; this component hides itself at `md` and up.
 *
 * Mobbin polish §14. Every action is a plain callback; the sheet closes
 * before it runs so the caller's own modal is not stacked under it.
 */

import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { VaulBottomSheet } from "@/components/ui/vaul-bottom-sheet";
import { cn } from "@/lib/utils";

export type RecordSheetAction = {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  /** Rendered last, in red. */
  destructive?: boolean;
  disabled?: boolean;
  dataAttr?: string;
};

export function PortalRecordActionSheet({
  title,
  actions,
  triggerLabel = "Options",
  triggerDataAttr,
}: {
  title: string;
  actions: RecordSheetAction[];
  triggerLabel?: string;
  triggerDataAttr?: string;
}) {
  const [open, setOpen] = useState(false);
  const ordered = [...actions.filter((a) => !a.destructive), ...actions.filter((a) => a.destructive)];
  if (ordered.length === 0) return null;
  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-attr={triggerDataAttr}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-border bg-card text-[14px] font-semibold text-foreground"
      >
        <MoreHorizontal className="size-4" aria-hidden />
        {triggerLabel}
      </button>
      <VaulBottomSheet open={open} onOpenChange={setOpen} title={title} flushBody>
        <ul className="divide-y divide-border/70 px-2 pb-2" data-attr="portal-record-action-sheet">
          {ordered.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                disabled={action.disabled}
                data-attr={action.dataAttr}
                onClick={() => {
                  setOpen(false);
                  // Let the sheet's close animation start before a modal opens on top.
                  window.setTimeout(action.onSelect, 120);
                }}
                className={cn(
                  "flex min-h-[52px] w-full items-center px-3 text-left text-[15px] font-semibold disabled:opacity-50",
                  action.destructive ? "text-[var(--status-overdue-fg)]" : "text-foreground",
                )}
              >
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      </VaulBottomSheet>
    </div>
  );
}
