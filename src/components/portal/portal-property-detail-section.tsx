"use client";

import type { ReactNode } from "react";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import { cn } from "@/lib/utils";

/** Outline pill actions in property detail tab toolbars and list rows. */
export const PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS =
  "h-8 min-h-0 w-auto max-w-none shrink-0 rounded-full px-3 text-xs font-semibold";

/** Left-aligned compact cluster for pinned property detail footers (Save, Edit, …). */
export const PORTAL_PROPERTY_DETAIL_FOOTER_ACTIONS_CLASS =
  "flex w-full min-w-0 flex-nowrap items-center justify-start gap-2 [&_button]:w-auto [&_button]:max-w-none [&_button]:shrink-0";

export function PropertyDetailFooterActions({ children }: { children: ReactNode }) {
  return (
    <div className={PORTAL_PROPERTY_DETAIL_FOOTER_ACTIONS_CLASS} data-slot="property-detail-footer-actions">
      {children}
    </div>
  );
}

/** Flat list row inside property detail tabs (no card chrome). */
export const PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS =
  "flex flex-col gap-2 border-b border-border/50 py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3";

/** Action cluster for {@link PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS} — stacks under the label on phones. */
export const PORTAL_PROPERTY_DETAIL_LIST_ROW_ACTIONS_CLASS =
  "flex w-full shrink-0 flex-wrap items-center gap-2 pl-7 sm:w-auto sm:pl-0";

type PortalPropertyDetailSectionProps = {
  actions?: ReactNode;
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
        <PortalPageFooterActions pinned rowVariant="header" omitSpacer className="mt-3">
          <PropertyDetailFooterActions>{actions}</PropertyDetailFooterActions>
        </PortalPageFooterActions>
      ) : null}
    </div>
  );
}
