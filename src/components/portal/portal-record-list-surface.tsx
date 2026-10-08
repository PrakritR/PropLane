"use client";

/** Canonical portal list shell. Per-record menus reuse each panel's existing
 * action handlers; internal single-record selection is never a user-facing mode.
 * Loading/error/empty states share this surface across portals. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RowSelectionModeContext } from "@/components/ui/row-selection-mode";
import { TriangleAlert, type LucideIcon } from "lucide-react";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { Button } from "@/components/ui/button";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import {
  PortalListEmptyCard,
  type PortalListEmptyAction,
  type PortalListEmptySibling,
} from "@/components/portal/portal-list-empty-card";
import { PortalRecordShareHost } from "@/components/portal/portal-record-share-host";
import { cn } from "@/lib/utils";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { portalEmptyTitleFromAddLabel } from "@/lib/portal-empty-copy";
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
  listControls,
}: {
  /** The record rows. Rendered as-is so each tab keeps its own row variant. */
  children?: ReactNode;
  /**
   * The list's Group/Sort menus (`PortalListControls`) — only a list that
   * declares group/sort options passes this; every other list keeps today's
   * flat rendering exactly as it was. The surface itself never groups rows:
   * the caller groups its own typed rows with `list-grouping.ts` and wraps
   * them in `PortalListGroup` before handing them to `children`.
   */
  listControls?: ReactNode;
  /**
   * Names the list's one create action (the header card's blue +). It draws nothing
   * itself: no dashed "+ Add" row sits under the rows or in an empty list (captain,
   * Oct 6) — it only titles the empty card ("Add lease" → "No leases yet").
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
    /** Sidebar section whose glyph fills the tile. */
    section?: string;
    /** @deprecated The one empty card draws no sentence. */
    description?: string;
    sibling?: PortalListEmptySibling | null;
    actions?: PortalListEmptyAction[];
    tone?: "default" | "muted";
    clear?: { label: string; onClick: () => void; dataAttr?: string } | null;
  };
  isEmpty?: boolean;
  className?: string;
  dataAttr?: string;
  loading?: boolean;
  loadError?: string;
  onRetry?: () => void;
}) {
  const [scopeRevision, setScopeRevision] = useState(0);
  // M004 — skeleton -> content crossfade. `ui.listSurface`'s loading skeleton
  // (just tuned in b13) is a binary swap; this borrows the CROSSFADE opacity
  // handoff so the resolved content fades/rises in for ONE cycle right after
  // `loading` clears, rather than popping in — same zero-layout-shift
  // principle b13 already cares about (the swap itself is still instant; only
  // the newly-resolved content's own entrance is animated). Every list page
  // built on this shared surface gets it for free.
  const wasLoadingRef = useRef(loading);
  const [justLoaded, setJustLoaded] = useState(false);
  useEffect(() => {
    if (wasLoadingRef.current && !loading && !loadError) setJustLoaded(true);
    wasLoadingRef.current = loading;
  }, [loading, loadError]);
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
   * own `empty` node, or a card titled from `add` alone. Never the dashed box,
   * and never a second labeled Add button here — the band's + (or a page with
   * no band, its own primary) is already the one way to add, so an empty card
   * keeps only its title and any caller-supplied non-add actions (PLAN-0920-1058
   * area 1d, "1a · The list page" § header icon set).
   */
  const emptyBody = !isEmpty ? null : emptyCard ? (
    <PortalListEmptyCard
      title={emptyCard.title}
      section={emptyCard.section}
      tone={emptyCard.tone}
      clear={emptyCard.clear}
      sibling={emptyCard.sibling}
      actions={emptyCard.actions ?? []}
    />
  ) : empty ? (
    <div>{empty}</div>
  ) : addAction ? (
    // A list that reaches here with only an add label still gets the one card,
    // titled off that label ("Add lease" → "No leases yet") — never a generic
    // line, and never its own Add button beneath the title.
    <PortalListEmptyCard title={portalEmptyTitleFromAddLabel(addAction.label)} />
  ) : null;
  return (
    <RowSelectionModeContext.Provider value={selectable ? false : null}>
      <PortalRecordShareHost>
      <RecordActionContext.Provider value={selectable ? { actions: bulkActions, clear: () => clearRef.current?.(), scope: `${pathname}:${scopeRevision}` } : null}>
      <div className={cn(PORTAL_LIST_PAGE_BODY, className)} data-attr={dataAttr} data-slot="portal-record-list-surface">
        {listControls ? (
          // A whole header card (Move-in, House details) spans the row, left-justified
          // like every list; a small Group/Sort menu still sits at the right.
          <div
            className="flex items-center justify-end [&>[data-slot=portal-list-control-stack]]:w-full [&>[data-slot=portal-list-control-stack]]:flex-1"
            data-attr="portal-list-controls-row"
          >
            {listControls}
          </div>
        ) : null}
        {loading ? <div role="status" aria-label="Loading records" data-attr="portal-list-loading">
          <span className="sr-only">Loading records…</span>
          {/* Skeleton rows on the page itself (56px, hairline between) with a shimmer: no spinner, no card. */}
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-14 items-center gap-3 border-b border-border pl-[22px] pr-3.5 max-lg:h-16 max-lg:pl-4" aria-hidden>
              <i className="portal-skel block size-[38px] shrink-0 rounded-lg" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <i className="portal-skel block h-3 w-40 max-w-[60%] rounded-md" />
                <i className="portal-skel block h-2.5 w-28 max-w-[40%] rounded-md" />
              </span>
              <i className="portal-skel block h-3 w-16 rounded-md max-md:hidden" />
            </div>
          ))}
        </div> : loadError ? <div role="alert" className="flex flex-col items-center px-6 py-20 text-center" data-attr="portal-list-error">
          <span className="mb-3 grid size-10 place-items-center rounded-[10px] border border-[var(--input)] text-muted/75" aria-hidden>
            <TriangleAlert className="size-5" strokeWidth={1.6} />
          </span>
          <p className="mb-3 text-[15px] font-semibold text-foreground">{loadError}</p>
          <Button variant="outline" onClick={onRetry}>Try again</Button>
        </div> : <div
          className={cn(justLoaded && "motion-just-loaded")}
          onAnimationEnd={justLoaded ? () => setJustLoaded(false) : undefined}
        >{isEmpty ? emptyBody : children}</div>}
      </div>
      </RecordActionContext.Provider>
      </PortalRecordShareHost>
    </RowSelectionModeContext.Provider>
  );
}
