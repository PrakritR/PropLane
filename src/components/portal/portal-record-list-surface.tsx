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
import { Button } from "@/components/ui/button";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import {
  PortalListEmptyCard,
  type PortalListEmptyAction,
  type PortalListEmptySibling,
} from "@/components/portal/portal-list-empty-card";
import { cn } from "@/lib/utils";

export type PortalListAddConfig = {
  /** Legacy visible text. The surface now always shows "Add"; keep `ariaLabel` specific. */
  label?: string;
  /**
   * Accessible name. Every tab shows the same visible "ADD", so without this a
   * screen reader hears a page of identically-named buttons.
   */
  ariaLabel: string;
  /** Legacy per-list glyph. The surface draws a plus for every list now. */
  icon?: LucideIcon;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  dataAttr?: string;
  /** Override the default inline-when-nonempty rule. No surface does today — Tours
   *  used to and was the one tab whose ADD row looked different (AXI-160). */
  inline?: boolean;
  className?: string;
};

export function PortalRecordListSurface({
  children,
  add,
  bulkCount = 0,
  bulkActions,
  onBulkClear,
  empty,
  emptyCard,
  isEmpty = false,
  className,
  dataAttr,
}: {
  /** The record rows. Rendered as-is so each tab keeps its own row variant. */
  children?: ReactNode;
  /**
   * The dashed ADD row. It renders only while the list is EMPTY — a populated
   * list adds from the page head, and the dashed box under twenty rows was a
   * second Add nobody needed (Mobbin polish §10). A call site that sets
   * `inline` explicitly (either way) has no page-head Add — a ledger embedded
   * in a resident record — and keeps the row.
   */
  add?: PortalListAddConfig;
  bulkCount?: number;
  bulkActions?: ReactNode;
  /** Clears the selection — the ✕ at the end of the floating bulk bar. */
  onBulkClear?: () => void;
  /** Shown instead of `children` when `isEmpty`. Takes precedence over `emptyCard`. */
  empty?: ReactNode;
  /**
   * The titled empty state (§15): what appears on this tab, a sibling tab
   * that has rows, and the real actions. When omitted and `add` is set, the
   * surface builds one from `add` — so no tab shows a bare dashed box.
   */
  emptyCard?: {
    title: string;
    description?: string;
    sibling?: PortalListEmptySibling | null;
    actions?: PortalListEmptyAction[];
  };
  isEmpty?: boolean;
  className?: string;
  dataAttr?: string;
}) {
  const addAction = add
    ? { label: add.ariaLabel, onClick: add.onClick, disabled: add.disabled, dataAttr: add.dataAttr }
    : null;
  /*
   * What an empty tab shows: the caller's card (`emptyCard`), or the caller's
   * own `empty` node with the add action as a real button beneath it, or a
   * card built from `add` alone. Never the dashed box.
   */
  const emptyBody = !isEmpty ? null : emptyCard ? (
    <PortalListEmptyCard
      title={emptyCard.title}
      description={emptyCard.description}
      sibling={emptyCard.sibling}
      actions={emptyCard.actions ?? (addAction ? [addAction] : [])}
    />
  ) : empty ? (
    <div>
      {empty}
      {addAction ? (
        <div className="mt-3 flex justify-center">
          <Button
            type="button"
            className="rounded-full"
            onClick={addAction.onClick}
            disabled={addAction.disabled}
            data-attr={addAction.dataAttr}
          >
            {addAction.label}
          </Button>
        </div>
      ) : null}
    </div>
  ) : addAction ? (
    <PortalListEmptyCard title="Nothing here yet" actions={[addAction]} />
  ) : null;
  return (
    <>
      <div className={cn(PORTAL_LIST_PAGE_BODY, className)} data-attr={dataAttr}>
        {isEmpty ? emptyBody : children}
        {/* The dashed row survives only for a call site with an explicit `inline` — a
            ledger embedded in a resident record, which has no page head to add from. */}
        {add && add.inline != null && !isEmpty ? (
          <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
            <PortalListAddRow
              // Every list footer reads "+ Add"; the per-list glyph and long label
              // moved into the accessible name so the rows stay uniform.
              label="Add"
              ariaLabel={add.ariaLabel}
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
        <BulkActionBar count={bulkCount} hideCount variant="payments" onClear={onBulkClear}>
          <div className="flex min-w-0 flex-nowrap items-center justify-start gap-2">
            {bulkActions}
          </div>
        </BulkActionBar>
      ) : null}
    </>
  );
}
