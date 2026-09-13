"use client";

import { Children, Fragment, cloneElement, isValidElement, createContext, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const BULK_BAR_VISIBLE_ACTIONS = 2;
export const BulkBarActionLimitContext = createContext<number | null>(null);

function flattenActionContainers(children: ReactNode, prefix = "actions"): ReactNode[] {
  return Children.toArray(children).flatMap((child, index) => {
    const key = `${prefix}/${isValidElement(child) ? child.key ?? index : index}`;
    if (isValidElement<{ children?: ReactNode }>(child) && (child.type === Fragment || child.type === "div")) {
      return flattenActionContainers(child.props.children, key);
    }
    return [isValidElement(child) ? cloneElement(child, { key }) : child];
  });
}

/** Contextual actions stay in document flow, beside the list selection controls. */
export function BulkActionBar({ count, children, className, variant = "default", hideCount = false,
  countLabel, placement = "viewport", onClear,
}: { count: number; children: ReactNode; className?: string; variant?: "default" | "payments";
  hideCount?: boolean; countLabel?: (count: number) => string;
  placement?: "viewport" | "list-pane"; onClear?: () => void;
}) {
  if (count <= 0) return null;
  const actions = flattenActionContainers(children);
  return <div role="region" aria-label={`Bulk actions, ${count} items selected`}
    data-slot="bulk-action-bar" data-variant={variant} data-count={count} data-placement={placement}
    className={cn("flex min-w-0 basis-full flex-wrap items-center gap-2 border-t border-border pt-2", className)}>
    {!hideCount ? <span className="text-sm font-semibold">{countLabel ? countLabel(count) : `${count} selected`}</span> : null}
    <BulkBarActionLimitContext.Provider value={BULK_BAR_VISIBLE_ACTIONS}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {actions.slice(0, BULK_BAR_VISIBLE_ACTIONS)}
        {actions.length > BULK_BAR_VISIBLE_ACTIONS ? <details className="relative" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-full border border-border px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary" data-attr="list-selection-more">More</summary>
          <div className="absolute left-0 top-full z-30 mt-2 flex min-w-48 flex-col items-stretch gap-1 rounded-xl border border-border bg-card p-2 shadow-lg">{actions.slice(BULK_BAR_VISIBLE_ACTIONS)}</div>
        </details> : null}
      </div>
    </BulkBarActionLimitContext.Provider>
    {onClear ? <Button variant="ghost" onClick={onClear} aria-label="Clear selection">Done</Button> : null}
  </div>;
}
