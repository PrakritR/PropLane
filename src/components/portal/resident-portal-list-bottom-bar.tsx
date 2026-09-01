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
      <BulkActionBar count={selectionCount} hideCount variant={selectionBarVariant} className={className}>
        <PortalAdaptiveActionRow actions={selectionActions} align="start" gapPx={4} />
      </BulkActionBar>
    );
  }

  if (showDefaultBar && defaultActions) {
    return (
      <PortalPageFooterActions
        className={cn(
          "max-lg:inset-x-2.5 max-lg:bottom-[calc(var(--portal-native-bottom-nav-inset,0px)+0.75rem)] max-lg:rounded-2xl max-lg:border max-lg:shadow-md",
          className,
        )}
        rowVariant="header"
      >
        <div className="flex w-full min-w-0 [&_button]:!w-full [&_button]:justify-center">{defaultActions}</div>
      </PortalPageFooterActions>
    );
  }

  return null;
}
