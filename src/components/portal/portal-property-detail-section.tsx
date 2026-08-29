"use client";

import type { ReactNode } from "react";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import { cn } from "@/lib/utils";

/** Outline pill actions in property detail tab toolbars and list rows. */
export const PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS =
  "h-8 shrink-0 rounded-full px-3 text-xs";

/** Flat list row inside property detail tabs (no card chrome). */
export const PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS =
  "flex flex-col gap-2 border-b border-border/50 py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3";

/** Action cluster for {@link PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS} — stacks under the label on phones. */
export const PORTAL_PROPERTY_DETAIL_LIST_ROW_ACTIONS_CLASS =
  "flex w-full shrink-0 flex-wrap items-center gap-2 pl-7 sm:w-auto sm:pl-0";

type PortalPropertyDetailSectionProps = {
  actions?: ReactNode;
  actionsJustify?: "end" | "between";
  children: ReactNode;
  contentClassName?: string;
  surfaceMuted?: boolean;
  /** No outer card — sits on the portal page canvas (default). */
  bareSurface?: boolean;
};

/**
 * Property detail tab shell — optional right-aligned action toolbar, no duplicate section title.
 */
export function PortalPropertyDetailSection({
  actions,
  actionsJustify = "end",
  children,
  contentClassName,
  surfaceMuted = false,
  bareSurface = true,
}: PortalPropertyDetailSectionProps) {
  return (
    <div
      className={cn(
        !bareSurface && "overflow-hidden rounded-2xl border border-border bg-card",
        !bareSurface && surfaceMuted && "[html[data-theme=dark]_&]:portal-surface-muted",
      )}
    >
      <div className={contentClassName}>{children}</div>
      {actions ? (
        <PortalPageFooterActions
          className={cn(
            "mt-3",
            !bareSurface && "md:mt-4",
            actionsJustify === "end" &&
              "[&_[data-slot=portal-section-action-row]>div]:w-full [&_[data-slot=portal-section-action-row]>div]:justify-end",
            actionsJustify === "between" &&
              "[&_[data-slot=portal-section-action-row]>div]:w-full [&_[data-slot=portal-section-action-row]>div]:justify-between",
          )}
        >
          {actions}
        </PortalPageFooterActions>
      ) : null}
    </div>
  );
}
