"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LocalDestinationNav, type LocalDestinationNavItem } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PORTAL_COMMAND_ACTION_BTN } from "@/components/portal/portal-metrics";

/**
 * Shared command strip for manager resident-detail tabs (PRP-395).
 * Always renders Filter · Settings · Edit so every tab has the same shape —
 * Filter defaults to disabled (status lives in the pills above); Settings/Edit
 * stay visible and disable when the tab has nothing to open.
 */
export function ResidentDetailCommandToolbar({
  filter,
  onSettings,
  onEdit,
  settingsDisabled,
  editDisabled,
  settingsLabel = "Settings",
  editLabel = "Edit",
}: {
  filter?: ReactNode;
  onSettings?: () => void;
  onEdit?: () => void;
  settingsDisabled?: boolean;
  editDisabled?: boolean;
  settingsLabel?: string;
  editLabel?: string;
}) {
  return (
    <>
      {filter ?? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_COMMAND_ACTION_BTN}
          data-attr="resident-detail-filter"
          disabled
          title="Status filters live in the pills above"
        >
          Filter
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        data-attr="resident-detail-settings"
        disabled={settingsDisabled || !onSettings}
        onClick={() => onSettings?.()}
      >
        {settingsLabel}
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        data-attr="resident-detail-edit"
        disabled={editDisabled || !onEdit}
        onClick={() => onEdit?.()}
      >
        {editLabel}
      </Button>
    </>
  );
}

export function ResidentDetailSubsectionChrome({
  bucketItems,
  activeBucketId,
  onBucketChange,
  bucketAriaLabel,
  denseEqualRow = false,
  filter,
  onSettings,
  onEdit,
  settingsDisabled,
  editDisabled,
  settingsLabel,
  editLabel,
  activeFilterChips,
  className,
}: {
  bucketItems: LocalDestinationNavItem[];
  activeBucketId: string;
  onBucketChange: (id: string) => void;
  bucketAriaLabel: string;
  denseEqualRow?: boolean;
  filter?: ReactNode;
  onSettings?: () => void;
  onEdit?: () => void;
  settingsDisabled?: boolean;
  editDisabled?: boolean;
  settingsLabel?: string;
  editLabel?: string;
  activeFilterChips?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ?? "mb-3 shrink-0 space-y-2 bg-background"}>
      <LocalDestinationNav
        items={bucketItems}
        activeId={activeBucketId}
        onChange={onBucketChange}
        ariaLabel={bucketAriaLabel}
        size="toolbar"
        itemLayout="equal"
        denseEqualRow={denseEqualRow}
      />
      <PortalListControlStack
        variant="command"
        stickyDestinations={false}
        actions={
          <ResidentDetailCommandToolbar
            filter={filter}
            onSettings={onSettings}
            onEdit={onEdit}
            settingsDisabled={settingsDisabled}
            editDisabled={editDisabled}
            settingsLabel={settingsLabel}
            editLabel={editLabel}
          />
        }
        activeFilterChips={activeFilterChips}
      />
    </div>
  );
}
