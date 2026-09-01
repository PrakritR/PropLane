"use client";

import { type ReactNode } from "react";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";

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
      <BulkActionBar count={selectionCount} hideCount variant={selectionBarVariant} className={className}>
        <PortalAdaptiveActionRow actions={selectionActions} align="start" gapPx={4} />
      </BulkActionBar>
    );
  }

  if (showDefaultBar && defaultActions) {
    return (
      <BulkActionBar count={1} hideCount variant={selectionBarVariant} className={className}>
        <div className="flex w-full min-w-0 justify-start" data-bulk-action-actions>
          {defaultActions}
        </div>
      </BulkActionBar>
    );
  }

  return null;
}
