"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import type { InboxListSegment } from "@/components/portal/portal-inbox-ui";

export function CommunicationInboxRowCheckbox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="h-4 w-4 shrink-0 rounded border-border accent-primary"
      checked={checked}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
    />
  );
}

export function CommunicationListBulkBar({
  count,
  listSegment,
  onArchive,
  onRestore,
  onDelete,
  onEdit,
  showEdit = false,
  onClear,
  extraActions,
}: {
  count: number;
  listSegment: InboxListSegment;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  showEdit?: boolean;
  onClear: () => void;
  extraActions?: ReactNode;
}) {
  const archived = listSegment === "archived";

  return (
    <BulkActionBar count={count} hideCount variant="payments">
      <div className="flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto">
        {!archived && onArchive ? (
          <Button
            type="button"
            variant="outline"
            className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
            onClick={onArchive}
            data-attr="communication-bulk-archive"
          >
            Archive
          </Button>
        ) : null}
        {archived && onRestore ? (
          <Button
            type="button"
            variant="outline"
            className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
            onClick={onRestore}
            data-attr="communication-bulk-restore"
          >
            Restore
          </Button>
        ) : null}
        {archived && onDelete ? (
          <Button
            type="button"
            variant="outline"
            className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} border-rose-200 text-rose-700 hover:bg-[var(--status-overdue-bg)]`}
            onClick={onDelete}
            data-attr="communication-bulk-delete"
          >
            Delete
          </Button>
        ) : null}
        {showEdit && onEdit ? (
          <Button
            type="button"
            variant="outline"
            className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
            onClick={onEdit}
            data-attr="communication-bulk-edit"
          >
            Edit
          </Button>
        ) : null}
        {extraActions}
        <Button
          type="button"
          variant="outline"
          className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
          onClick={onClear}
          data-attr="communication-bulk-clear"
        >
          Clear
        </Button>
      </div>
    </BulkActionBar>
  );
}
