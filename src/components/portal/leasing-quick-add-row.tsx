"use client";

import { Plus } from "lucide-react";
import type { QuickAddEntry } from "@/lib/leasing-quick-add";

/**
 * The "Quick add" row at the bottom of every Application / Lease / Move-in list (wizard steps and property
 * tabs alike): one small add action per PropLane default the property does NOT currently carry, so a
 * deleted default comes back in one click. Renders nothing when every default is present.
 *
 * Flat, no pills: a plain label and text actions with a + glyph. `noun` only names the actions for
 * assistive tech and data-attrs.
 */
export function LeasingQuickAddRow({
  entries,
  onAdd,
  noun,
  dataAttr,
}: {
  entries: readonly QuickAddEntry[];
  onAdd: (key: string) => void;
  /** "application" | "lease" | "move-in form" */
  noun: string;
  dataAttr: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-border bg-card px-3.5 py-2"
      role="group"
      aria-label="Quick add"
      data-attr={dataAttr}
    >
      <span className="text-[13px] font-extrabold text-muted">Quick add</span>
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          className="inline-flex min-h-[40px] items-center gap-1 text-[13.5px] font-semibold text-primary hover:underline"
          aria-label={`Add ${entry.label} (${noun})`}
          data-attr={`${dataAttr}-${entry.key}`}
          onClick={() => onAdd(entry.key)}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
          {entry.label}
        </button>
      ))}
    </div>
  );
}
