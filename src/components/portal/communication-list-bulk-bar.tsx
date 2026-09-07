"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import type { InboxListSegment } from "@/components/portal/portal-inbox-ui";

/**
 * The conversation-row checkbox shared by the manager, resident and vendor
 * inboxes. It sits on a row whose own click OPENS the conversation, so a
 * near-miss used to navigate away instead of selecting (PRP-369) —
 * `RowSelectCheckbox` gives it a thumb-sized hit pad and swallows the click.
 */
export function CommunicationInboxRowCheckbox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return <RowSelectCheckbox checked={checked} onChange={onToggle} aria-label={label} />;
}

export function CommunicationListBulkBar({
  count,
  listSegment,
  onArchive,
  onRestore,
  onDelete,
  onEdit,
  showEdit = false,
  extraActions,
}: {
  count: number;
  listSegment: InboxListSegment;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  showEdit?: boolean;
  extraActions?: ReactNode;
}) {
  const archived = listSegment === "archived";

  return (
    <BulkActionBar count={count} hideCount variant="payments" placement="list-pane">
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
      </div>
    </BulkActionBar>
  );
}
