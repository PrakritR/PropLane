"use client";

/**
 * The canonical portal list surface.
 *
 * Properties was the first list to get this shape — a flat run of selectable
 * record rows, a dashed ADD footer, and a floating bulk bar that only exists
 * while something is selected — and it is now the shape every list tab in
 * every portal uses. It lives here rather than being re-typed per panel so the
 * gutters, the add-row padding, and the bulk-bar variant cannot drift apart
 * again; the previous state of the code had each tab re-deriving them by hand
 * and no two agreed.
 *
 * This composes existing primitives, it does not replace them: a panel that
 * needs something the surface does not model still renders its own rows as
 * `children`. The surface only owns the wrapper, the footer, and the bar.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { cn } from "@/lib/utils";

export type PortalListAddConfig = {
  /** Visible text. Rendered uppercase by the add row; "Add" is the house default. */
  label?: string;
  /**
   * Accessible name. Every tab shows the same visible "ADD", so without this a
   * screen reader hears a page of identically-named buttons.
   */
  ariaLabel: string;
  icon?: LucideIcon;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  dataAttr?: string;
  /** Override the default inline-when-nonempty rule (e.g. tours always use the compact footer). */
  inline?: boolean;
  className?: string;
};

export function PortalRecordListSurface({
  children,
  add,
  bulkCount = 0,
  bulkActions,
  empty,
  isEmpty = false,
  className,
  dataAttr,
}: {
  /** The record rows. Rendered as-is so each tab keeps its own row variant. */
  children?: ReactNode;
  /** Dashed footer. Omit for a list that cannot be added to from this surface. */
  add?: PortalListAddConfig;
  bulkCount?: number;
  bulkActions?: ReactNode;
  /** Shown instead of `children` when `isEmpty`. The ADD row still renders. */
  empty?: ReactNode;
  isEmpty?: boolean;
  className?: string;
  dataAttr?: string;
}) {
  return (
    <>
      <div className={cn(PORTAL_LIST_PAGE_BODY, className)} data-attr={dataAttr}>
        {isEmpty ? empty : children}
        {add ? (
          <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
            <PortalListAddRow
              label={add.label ?? "Add"}
              ariaLabel={add.ariaLabel}
              icon={add.icon}
              hint={add.hint}
              onClick={add.onClick}
              disabled={add.disabled}
              dataAttr={add.dataAttr}
              className={add.className}
              // Inline once rows exist above it, unless a list opts into compact always.
              inline={add.inline ?? !isEmpty}
            />
          </div>
        ) : null}
      </div>
      {bulkCount > 0 && bulkActions ? (
        <BulkActionBar count={bulkCount} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2" data-bulk-action-actions>
            {bulkActions}
          </div>
        </BulkActionBar>
      ) : null}
    </>
  );
}
