"use client";

/** Canonical portal list shell. Per-record menus reuse each panel's existing
 * action handlers; internal single-record selection is never a user-facing mode.
 * Loading/error/empty states share this surface across portals. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RowSelectionModeContext } from "@/components/ui/row-selection-mode";
import type { LucideIcon } from "lucide-react";
import { RecordActionContext } from "@/components/ui/record-action-context";
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
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

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
  bulkActions,
  onBulkClear,
  empty,
  emptyCard,
  isEmpty = false,
  className,
  dataAttr, loading = false, loadError, onRetry,
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
  /** Clears all selected IDs, including rows removed by a filter or refresh. */
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
  loading?: boolean;
  loadError?: string;
  onRetry?: () => void;
}) {
  const [scopeRevision, setScopeRevision] = useState(0);
  const clearRef = useRef(onBulkClear);
  useEffect(() => { clearRef.current = onBulkClear; }, [onBulkClear]);
  const pathname = usePathname();
  const selectable = Boolean(onBulkClear || bulkActions);
  useEffect(() => { clearRef.current?.(); }, [pathname]);
  useEffect(() => {
    const reset = () => { setScopeRevision((n) => n + 1); clearRef.current?.(); };
    window.addEventListener(WORKSPACE_SELECTION_EVENT, reset);
    const unsubscribe = onPortalSessionViewerChange(reset);
    return () => { window.removeEventListener(WORKSPACE_SELECTION_EVENT, reset); unsubscribe(); };
  }, []);
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
    <RowSelectionModeContext.Provider value={selectable ? false : null}>
      <RecordActionContext.Provider value={selectable ? { actions: bulkActions, clear: () => clearRef.current?.(), scope: `${pathname}:${scopeRevision}` } : null}>
      <div className={cn(PORTAL_LIST_PAGE_BODY, className)} data-attr={dataAttr}>
        {loading ? <div role="status" aria-label="Loading records" className="space-y-3 rounded-2xl border border-border bg-card p-5">
          <span className="sr-only">Loading records…</span>
          {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-accent/50 motion-reduce:animate-none" />)}
        </div> : loadError ? <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center">
          <p className="mb-3 text-sm">{loadError}</p><Button variant="outline" onClick={onRetry}>Try again</Button>
        </div> : <div>{isEmpty ? emptyBody : children}</div>}
        {/* The dashed row survives only for a call site with an explicit `inline` — a
            ledger embedded in a resident record, which has no page head to add from. */}
        {add && add.inline != null && !isEmpty && !loading && !loadError ? (
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
      </RecordActionContext.Provider>
    </RowSelectionModeContext.Provider>
  );
}
