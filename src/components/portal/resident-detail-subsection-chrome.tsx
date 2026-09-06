"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LocalDestinationNav, type LocalDestinationNavItem } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PORTAL_COMMAND_ACTION_BTN } from "@/components/portal/portal-metrics";

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
      {filter ?? null}
      {onSettings ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_COMMAND_ACTION_BTN}
          data-attr="resident-detail-settings"
          disabled={settingsDisabled}
          onClick={onSettings}
        >
          {settingsLabel}
        </Button>
      ) : null}
      {onEdit ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_COMMAND_ACTION_BTN}
          data-attr="resident-detail-edit"
          disabled={editDisabled}
          onClick={onEdit}
        >
          {editLabel}
        </Button>
      ) : null}
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
  const showToolbar = Boolean(filter || onSettings || onEdit);

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
      {showToolbar ? (
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
      ) : null}
    </div>
  );
}
