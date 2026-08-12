"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import {
  computeSharedSlotActionBudget,
  pickAdaptiveActions,
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
  if (slot && slot.clientWidth > 0) {
    const bandRow = sectionRow?.parentElement;
    if (
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
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const { optional } = useMemo(() => splitAdaptiveActions(actions), [actions]);
  const [optionalFitCount, setOptionalFitCount] = useState(optional.length);
  const moreBtnClass = moreButtonClassName ?? DEFAULT_MORE_BTN;

  const pinnedCount = pinnedMenuItems.length;

  useLayoutEffect(() => {
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
  }, [actions, gapPx, optional.length]);

  useLayoutEffect(() => {
    const row = containerRef.current;
    if (!row) return;
    if (row.scrollWidth <= row.clientWidth + SCROLL_OVERFLOW_TOLERANCE_PX) return;
    if (optionalFitCount > 0) {
      setOptionalFitCount((count) => Math.max(0, count - 1));
      return;
    }
    if (optional.length > 0 && optionalFitCount >= optional.length) {
      setOptionalFitCount((count) => Math.max(0, count - 1));
    }
  }, [optionalFitCount, optional.length, actions]);

  if (actions.length === 0 && pinnedCount === 0) return null;

  const { visible, overflow } = pickAdaptiveActions(actions, optionalFitCount);
  const showMoreMenu = overflow.length > 0;
  const { leading: visibleLeading, optional: visibleMiddle, trailing: visibleTrailing } =
    splitAdaptiveActions(visible);

  const moreMenu = showMoreMenu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={moreBtnClass}
          data-attr={moreDataAttr}
          aria-label={moreAriaLabel}
        >
          …
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" backdrop>
        {overflow.map((action) => (
          <div key={action.id}>{action.menuItem}</div>
        ))}
        {overflow.length > 0 && pinnedCount > 0 ? <DropdownMenuSeparator /> : null}
        {pinnedMenuItems.map((item, index) => (
          <div key={index}>{item}</div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div className="relative min-w-0 w-full flex-1 overflow-hidden">
      <div
        ref={measureRef}
        className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex gap-0.5"
        style={{ gap: gapPx }}
        aria-hidden
      >
        {actions.map((action) => (
          <div key={action.id} data-portal-adaptive-fit-action>
            {action.node}
          </div>
        ))}
        <div data-portal-adaptive-fit-more>
          <Button type="button" variant="outline" className={moreBtnClass} tabIndex={-1}>
            …
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        className={cn(DEFAULT_ROW_CLASS, rowAlignClass(align), rowClassName, className)}
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
        {visibleTrailing.map((action) => (
          <div key={action.id} className="shrink-0">
            {action.node}
          </div>
        ))}
        {moreMenu ? <div className="shrink-0">{moreMenu}</div> : null}
      </div>
    </div>
  );
}

/** @deprecated Use {@link PortalAdaptiveActionRow}. */
export const PortalAdaptiveHeaderActions = PortalAdaptiveActionRow;

export type { PortalAdaptiveAction, PortalAdaptiveAction as PortalAdaptiveHeaderAction } from "@/lib/portal-adaptive-actions";
export {
  computeSharedSlotActionBudget,
  fitOptionalBetweenEdges,
  pickAdaptiveActions,
  pickAdaptiveActions as pickAdaptiveHeaderActions,
  pickVisibleActions,
  renderedAdaptiveRowWidth,
  resolveAdaptiveOptionalFitCount,
  splitAdaptiveActions,
  splitAdaptiveActions as splitAdaptiveHeaderActions,
} from "@/lib/portal-adaptive-actions";
