"use client";

import { type ReactNode } from "react";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { cn } from "@/lib/utils";

/**
 * Resident list sections: primary actions dock above the native tab bar on mobile;
 * when rows are selected, swap to the manager-style bulk action bar.
 */
export function ResidentPortalListBottomBar({
  showDefaultBar = false,
  defaultActions,
  selectionCount,
  selectionActions = [],
  selectionBarVariant = "default",
  className,
}: {
  showDefaultBar?: boolean;
  defaultActions?: ReactNode;
  selectionCount: number;
  selectionActions?: PortalAdaptiveAction[];
  selectionBarVariant?: "default" | "payments";
  className?: string;
}) {
  if (selectionCount > 0 && selectionActions.length > 0) {
    return (
      <BulkActionBar count={selectionCount} variant={selectionBarVariant} className={className}>
        <PortalAdaptiveActionRow actions={selectionActions} align="start" gapPx={4} />
      </BulkActionBar>
    );
  }

  if (showDefaultBar && defaultActions) {
    return (
      <PortalPageFooterActions className={cn("md:hidden", className)} rowVariant="header">
        <div className="flex w-full min-w-0 flex-nowrap items-center justify-end gap-2">{defaultActions}</div>
      </PortalPageFooterActions>
    );
  }

  return null;
}
