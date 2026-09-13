"use client";

import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";

// The edit/delete dialog owns modal focus and pointer locking after selection.
export function ExpenseRowMenu({
  onEdit,
  onDelete,
}: {
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  if (!onEdit && !onDelete) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        aria-label="Expense actions"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-portal-row-ignore
        data-attr="expense-row-menu"
      >
        <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" backdrop>
        {onEdit ? (
          <DropdownMenuItem data-attr="expense-edit" onSelect={onEdit}>
            Edit
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <DropdownMenuItem data-attr="expense-delete" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
