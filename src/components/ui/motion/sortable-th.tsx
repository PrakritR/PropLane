"use client";

/**
 * M016 — the clickable/keyboard `<th>` half of a sortable table, paired with
 * {@link useFlipRows} (flip-rows.ts) for the row-travel animation. See that
 * file's own header for the interior.dev source this ports.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SortDir = "ascending" | "descending" | null;

export function SortableTh({
  children,
  dir,
  onSort,
  className,
}: {
  children: ReactNode;
  /** `null` when this column is not the current sort key. */
  dir: SortDir;
  onSort: () => void;
  className?: string;
}) {
  return (
    <th
      role="columnheader"
      tabIndex={0}
      aria-sort={dir ?? "none"}
      onClick={onSort}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort();
        }
      }}
      className={cn("motion-sortable-th", className)}
    >
      <span>{children}</span>
      <span aria-hidden className="motion-sort-glyph">
        ▴
      </span>
    </th>
  );
}

/** Visually-hidden `role="status"` sort announcement, one per table. */
export function SortLiveRegion({ text }: { text: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {text}
    </span>
  );
}
