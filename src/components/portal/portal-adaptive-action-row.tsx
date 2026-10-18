"use client";

import { MoreHorizontal } from "lucide-react";
import { Fragment, cloneElement, isValidElement, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { RecordActionItemsContext, RecordActionCloseContext } from "@/components/ui/record-action-context";
import { RecordActionItems, isRecordActionRowShape, withRecordActionIcon } from "@/components/ui/record-action-menu";
import { BulkBarActionLimitContext } from "@/components/ui/bulk-action-bar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { RecordHeaderHostContext, useLgUp } from "@/components/portal/portal-title-actions-slot";
import {
  computeSharedSlotActionBudget,
  pickAdaptiveActions,
  recordHeaderInlineCap,
  resolveAdaptiveOptionalFitCount,
  splitAdaptiveActions,
  type PortalAdaptiveAction,
} from "@/lib/portal-adaptive-actions";
import { cn } from "@/lib/utils";

const DEFAULT_GAP_PX = 8;
/** Absorbs subpixel rounding the hidden measure row can miss. */
const WIDTH_FUDGE_PX = 4;
const SCROLL_OVERFLOW_TOLERANCE_PX = 2;
const rowAlignClass = (align: "start" | "end") =>
  align === "end" ? "justify-end" : "justify-start";
const DEFAULT_ROW_CLASS = "flex min-w-0 flex-1 basis-0 flex-nowrap items-center gap-0.5 overflow-hidden";
const DEFAULT_MORE_BTN = cn(PORTAL_HEADER_ACTION_BTN, "max-lg:px-3 max-lg:text-base");

function measureAvailableWidth(container: HTMLElement, gapPx: number): number {
  const sectionRow = container.closest<HTMLElement>("[data-slot='portal-section-action-row']");
  const slot = container.closest<HTMLElement>("[data-portal-action-slot]");
  const bandRow = sectionRow?.parentElement;

  // A record's detail header hands its actions a CONTENT-SIZED slot, so the row's own
  // clientWidth is whatever it is already rendering — measure that and a folded row stays
  // folded forever. The header marks the flex child that really owns the leftover space;
  // the budget is that width minus the static buttons sitting beside the slot.
  const recordHeader = container.closest<HTMLElement>("[data-portal-record-header-actions]");
  if (recordHeader && recordHeader.clientWidth > 0) {
    const siblingWidths: number[] = [];
    for (const child of recordHeader.children) {
      if (child instanceof HTMLElement && !child.contains(container)) {
        siblingWidths.push(child.offsetWidth);
      }
    }
    const headerGap = parseFloat(getComputedStyle(recordHeader).gap) || gapPx;
    const budget = computeSharedSlotActionBudget(recordHeader.clientWidth, siblingWidths, headerGap);
    if (budget > 0) return budget;
  }
  if (
    slot &&
    slot.clientWidth > 0 &&
    sectionRow &&
    bandRow &&
    bandRow !== slot &&
    slot.contains(bandRow) &&
    bandRow.parentElement === slot
  ) {
    const siblingWidths: number[] = [];
    for (const child of bandRow.children) {
      if (child instanceof HTMLElement && child !== sectionRow) {
        siblingWidths.push(child.offsetWidth);
      }
    }
    if (siblingWidths.length > 0) {
      const bandGap = parseFloat(getComputedStyle(bandRow).gap) || gapPx;
      const budget = computeSharedSlotActionBudget(slot.clientWidth, siblingWidths, bandGap);
      if (budget > 0) return budget;
    }
  }

  if (container.clientWidth > 0) return container.clientWidth;

  if (sectionRow && sectionRow.clientWidth > 0) return sectionRow.clientWidth;

  if (slot && slot.clientWidth > 0) return slot.clientWidth;

  let minWidth = Infinity;
  let node: HTMLElement | null = container.parentElement;
  while (node) {
    const width = node.clientWidth;
    if (width > 0) minWidth = Math.min(minWidth, width);
    if (node.dataset.slot === "portal-page-title-band") break;
    node = node.parentElement;
  }
  if (Number.isFinite(minWidth) && minWidth > 0) return minWidth;

  return 0;
}

/**
 * A header ⋯ item carries its glyph like every other action menu (16px, leading). A plain-text item gets the
 * icon of the inline action it stands in for; an item that already draws its own child element is left alone.
 */
function overflowMenuItem(action: PortalAdaptiveAction): ReactNode {
  const { node, menuItem } = action;
  if (!isValidElement<{ icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }> }>(node)) return menuItem;
  const Icon = node.props.icon;
  if (!Icon || !isValidElement<{ children?: ReactNode; className?: string }>(menuItem) || menuItem.type !== DropdownMenuItem) return menuItem;
  if (typeof menuItem.props.children !== "string") return menuItem;
  return cloneElement(menuItem, undefined, <Icon aria-hidden />, <span className="min-w-0 truncate">{menuItem.props.children}</span>);
}

/**
 * Fit as many inline actions as a row allows; overflow moves into a trailing … menu.
 * Shared by page title bands and docked bulk-selection bars.
 */
export function PortalAdaptiveActionRow({
  actions,
  pinnedMenuItems = [],
  moreAriaLabel = "More actions",
  moreDataAttr,
  className,
  rowClassName,
  moreButtonClassName,
  gapPx = DEFAULT_GAP_PX,
  align = "start",
  /**
   * Show this many actions without measuring; only the rest fold into "…".
   *
   * The floating selection pill sizes itself to its content, so measuring
   * "how many fit" there is circular — it always came back as none and every
   * action hid behind the dots. Inside the pill the rule is a count, not a
   * width. Set automatically when rendered inside {@link BulkActionBar}.
   */
  maxVisible,
}: {
  actions: PortalAdaptiveAction[];
  pinnedMenuItems?: ReactNode[];
  moreAriaLabel?: string;
  moreDataAttr?: string;
  className?: string;
  rowClassName?: string;
  moreButtonClassName?: string;
  gapPx?: number;
  /** Row alignment inside its slot — bulk bars and mobile title bands use start. */
  align?: "start" | "end";
  maxVisible?: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const { optional } = useMemo(() => splitAdaptiveActions(actions), [actions]);
  const [measuredFitCount, setOptionalFitCount] = useState(optional.length);
  const inRecordMenu = useContext(RecordActionItemsContext);
  const bulkBarLimit = useContext(BulkBarActionLimitContext);
  const inRecordHeader = useContext(RecordHeaderHostContext);
  const lgUp = useLgUp();
  const fixedLimit = inRecordMenu ? actions.length : maxVisible ?? bulkBarLimit;
  const fixed = fixedLimit != null;
  // A record header still MEASURES; the cap only stops it inlining more icons than a header
  // should ever carry. Folding is decided by the space the header actually has.
  const headerCap = fixed ? undefined : recordHeaderInlineCap(actions.length, inRecordHeader, lgUp);
  const optionalCap =
    headerCap != null ? Math.max(0, headerCap - (actions.length - optional.length)) : undefined;
  const optionalFitCount = fixed
    ? Math.max(0, fixedLimit - (actions.length - optional.length))
    : optionalCap != null
      ? Math.min(measuredFitCount, optionalCap)
      : measuredFitCount;
  const moreBtnClass = moreButtonClassName ?? DEFAULT_MORE_BTN;

  const pinnedCount = pinnedMenuItems.length;

  useLayoutEffect(() => {
    if (fixed) return;
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure || actions.length === 0) {
      setOptionalFitCount(optional.length);
      return;
    }

    const sync = () => {
      const containerWidth = measureAvailableWidth(container, gapPx);
      if (containerWidth <= 0) return;

      const buttons = [...measure.querySelectorAll<HTMLElement>("[data-portal-adaptive-fit-action]")];
      const widths = buttons.map((node) => node.offsetWidth);
      if (widths.length !== actions.length) return;

      const moreNode = measure.querySelector<HTMLElement>("[data-portal-adaptive-fit-more]");
      const moreWidth = moreNode?.offsetWidth ?? 40;

      const widthFor = (action: PortalAdaptiveAction) =>
        widths[actions.findIndex((item) => item.id === action.id)] ?? 0;

      const count = resolveAdaptiveOptionalFitCount(
        actions,
        widthFor,
        moreWidth,
        Math.max(0, containerWidth - WIDTH_FUDGE_PX),
        gapPx,
        { reserveMore: pinnedCount > 0 },
      );
      setOptionalFitCount(count);
    };

    sync();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(sync);
      const slot = container.closest("[data-portal-action-slot]");
      ro.observe(container);
      if (container.parentElement) ro.observe(container.parentElement);
      if (slot instanceof HTMLElement) ro.observe(slot);
    }
    window.addEventListener("resize", sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [actions, fixed, gapPx, optional.length, pinnedCount]);

  useLayoutEffect(() => {
    if (fixed) return;
    const row = containerRef.current;
    if (!row) return;
    // During mount (or inside a clipped overflow-hidden ancestor) clientWidth can
    // still be 0 while scrollWidth is the full button row. Treating that as
    // "overflow" collapses every optional action into … — or, with no pins, into
    // an empty-looking bulk bar. Wait until the row has a real width.
    if (row.clientWidth <= 0) return;
    if (row.scrollWidth <= row.clientWidth + SCROLL_OVERFLOW_TOLERANCE_PX) return;
    if (optionalFitCount > 0) {
      setOptionalFitCount((count) => Math.max(0, count - 1));
      return;
    }
    if (optional.length > 0 && optionalFitCount >= optional.length) {
      setOptionalFitCount((count) => Math.max(0, count - 1));
    }
  }, [fixed, optionalFitCount, optional.length, actions]);

  // The action's own `menuItem` is the menu shape (glyph + label) the overflow
  // path already uses; `node` is a bare icon button for a header row, which
  // `withRecordActionIcon` cannot re-shape once it is a forwardRef component.
  // A `menuItem` that is not a shape RecordActionItems can turn into a row
  // (the type is a bare ReactNode) would land here inert, so fall back to
  // `node`, which every caller builds from a Button.
  const recordMenuNode = (action: PortalAdaptiveAction) =>
    withRecordActionIcon(isRecordActionRowShape(action.menuItem) ? action.menuItem : action.node);
  if (inRecordMenu) return <><RecordActionItems>{actions.map((action) => <Fragment key={action.id}>{recordMenuNode(action)}</Fragment>)}{pinnedMenuItems}</RecordActionItems></>;
  if (actions.length === 0 && pinnedCount === 0) return null;

  const { visible, overflow } = pickAdaptiveActions(actions, optionalFitCount);
  const showMoreMenu = overflow.length > 0 || pinnedCount > 0;
  const { leading: visibleLeading, optional: visibleMiddle, trailing: visibleTrailing } =
    splitAdaptiveActions(visible);

  const moreMenu = showMoreMenu ? (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={moreBtnClass}
          data-attr={moreDataAttr}
          aria-label={moreAriaLabel}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="record-action-menu">
        <RecordActionCloseContext.Provider value={() => setMenuOpen(false)}>
        {overflow.map((action) => (
          <div key={action.id}>{overflowMenuItem(action)}</div>
        ))}
        {overflow.length > 0 && pinnedCount > 0 ? <DropdownMenuSeparator /> : null}
        {pinnedMenuItems.map((item, index) => (
          <div key={index}>{item}</div>
        ))}
        </RecordActionCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div className={cn("relative min-w-0", fixed ? "w-auto" : "w-full flex-1 overflow-hidden")}>
      {fixed ? null : (
      <div
        ref={measureRef}
        className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex gap-0.5"
        style={{ gap: gapPx }}
        aria-hidden
        inert
      >
        {actions.map((action) => (
          <div key={action.id} data-portal-adaptive-fit-action>
            {action.node}
          </div>
        ))}
        <div data-portal-adaptive-fit-more>
          <Button type="button" variant="outline" className={moreBtnClass} tabIndex={-1}>
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      )}
      <div
        ref={containerRef}
        className={cn(fixed ? "flex min-w-0 flex-nowrap items-center gap-0.5" : DEFAULT_ROW_CLASS, rowAlignClass(align), rowClassName, className)}
        style={{ gap: gapPx }}
      >
        {visibleLeading.map((action) => (
          <div key={action.id} className="shrink-0">
            {action.node}
          </div>
        ))}
        {visibleMiddle.map((action) => (
          <div key={action.id} className="shrink-0">
            {action.node}
          </div>
        ))}
        {moreMenu ? <div className="shrink-0">{moreMenu}</div> : null}
        {visibleTrailing.map((action) => (
          <div key={action.id} className="shrink-0">
            {action.node}
          </div>
        ))}
      </div>
    </div>
  );
}

/** @deprecated Use {@link PortalAdaptiveActionRow}. */
export const PortalAdaptiveHeaderActions = PortalAdaptiveActionRow;

export type { PortalAdaptiveAction, PortalAdaptiveAction as PortalAdaptiveHeaderAction } from "@/lib/portal-adaptive-actions";
export {
  computeSharedSlotActionBudget,
  recordHeaderInlineCap,
  fitOptionalBetweenEdges,
  pickAdaptiveActions,
  pickAdaptiveActions as pickAdaptiveHeaderActions,
  pickVisibleActions,
  renderedAdaptiveRowWidth,
  resolveAdaptiveOptionalFitCount,
  splitAdaptiveActions,
  splitAdaptiveActions as splitAdaptiveHeaderActions,
} from "@/lib/portal-adaptive-actions";
