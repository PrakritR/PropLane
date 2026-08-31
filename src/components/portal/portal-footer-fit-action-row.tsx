"use client";

import { forwardRef, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const FOOTER_ACTION_ROW =
  "flex w-full min-w-0 flex-nowrap items-center justify-start gap-2";

export const PORTAL_FOOTER_MORE_BTN =
  "inline-flex h-10 min-h-0 w-10 min-w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card/80 p-0 text-base font-bold leading-none text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-primary/30 hover:bg-card [html[data-theme=dark]_&]:portal-outline-control";

export type PortalFooterFitAction = {
  id: string;
  button: ReactNode;
  menuItem: ReactNode;
};

const PortalFooterMoreTrigger = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label"?: string }
>(function PortalFooterMoreTrigger({ className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(PORTAL_FOOTER_MORE_BTN, className)}
      aria-label={props["aria-label"] ?? "More actions"}
      {...props}
    >
      <span aria-hidden>⋯</span>
    </button>
  );
});

/** Measures pinned footer width and tucks overflow actions into a ⋯ menu (lease + application detail). */
export function PortalFooterFitActionRow({
  actions,
  moreLabel = "More actions",
  destructiveIds = ["delete"],
}: {
  actions: PortalFooterFitAction[];
  moreLabel?: string;
  destructiveIds?: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(actions.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure || actions.length === 0) {
      setVisibleCount(actions.length);
      return;
    }

    const gap = 8;

    const sync = () => {
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;

      const buttons = [...measure.querySelectorAll<HTMLElement>("[data-portal-footer-fit-action]")];
      const widths = buttons.map((node) => node.offsetWidth);
      if (widths.length === 0) return;

      const moreNode = measure.querySelector<HTMLElement>("[data-portal-footer-fit-more]");
      const moreWidth = moreNode?.offsetWidth ?? 40;

      const fitCount = (reserveMore: boolean) => {
        let used = 0;
        let count = 0;
        for (let i = 0; i < widths.length; i++) {
          const width = widths[i] ?? 0;
          const gapBefore = count > 0 ? gap : 0;
          const itemsAfter = widths.length - i - 1;
          const moreReserve = reserveMore && itemsAfter > 0 ? gap + moreWidth : 0;
          if (used + gapBefore + width + moreReserve <= containerWidth) {
            used += gapBefore + width;
            count++;
          } else {
            break;
          }
        }
        return count;
      };

      let count = fitCount(false);
      if (count < widths.length) {
        count = fitCount(true);
      }
      setVisibleCount(Math.max(1, Math.min(count, widths.length)));
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(container);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [actions]);

  if (actions.length === 0) return null;

  const visible = actions.slice(0, visibleCount);
  const overflow = actions.slice(visibleCount);
  const destructiveSet = new Set(destructiveIds);

  return (
    <>
      <div
        ref={measureRef}
        className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex gap-2"
        aria-hidden
      >
        {actions.map((action) => (
          <div key={action.id} data-portal-footer-fit-action>
            {action.button}
          </div>
        ))}
        <div data-portal-footer-fit-more>
          <PortalFooterMoreTrigger aria-label={moreLabel} />
        </div>
      </div>
      <div ref={containerRef} className={FOOTER_ACTION_ROW}>
        {visible.map((action) => (
          <div key={action.id} className="shrink-0">
            {action.button}
          </div>
        ))}
        {overflow.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <PortalFooterMoreTrigger aria-label={moreLabel} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="z-[60] min-w-[12rem]" backdrop>
              {overflow
                .filter((action) => !destructiveSet.has(action.id))
                .map((action) => (
                  <div key={action.id}>{action.menuItem}</div>
                ))}
              {overflow.some((action) => !destructiveSet.has(action.id)) &&
              overflow.some((action) => destructiveSet.has(action.id)) ? (
                <DropdownMenuSeparator />
              ) : null}
              {overflow
                .filter((action) => destructiveSet.has(action.id))
                .map((action) => (
                  <div key={action.id}>{action.menuItem}</div>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </>
  );
}
