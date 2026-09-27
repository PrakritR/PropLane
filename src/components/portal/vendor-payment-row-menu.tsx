"use client";

import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";

/**
 * Vendor Payments row ⋯ (VD14): View always when the row has a detail page;
 * Edit + Withdraw only for a submitted invoice (Withdraw here retracts the
 * submission — the same existing action, not a money withdrawal); Download
 * only for a paid/approved row. Same lightweight `DropdownMenu` shape as
 * `ExpenseRowMenu` rather than the shared-scope `RecordActionContext` one,
 * since each row's actions are fully self-contained.
 */
export function VendorPaymentRowMenu({
  label,
  onView,
  onEdit,
  onWithdraw,
  withdrawing = false,
  onDownload,
}: {
  label: string;
  onView?: () => void;
  onEdit?: () => void;
  onWithdraw?: () => void;
  /** True while this row's own withdraw (invoice retraction) request is in flight. */
  withdrawing?: boolean;
  onDownload?: () => void;
}) {
  if (!onView && !onEdit && !onWithdraw && !onDownload) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        aria-label={`${label} actions`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-portal-row-ignore
        data-attr="vendor-payment-row-menu"
      >
        <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onView ? (
          <DropdownMenuItem data-attr="vendor-payment-view" onSelect={onView}>
            View
          </DropdownMenuItem>
        ) : null}
        {onEdit ? (
          <DropdownMenuItem data-attr="vendor-payment-edit" onSelect={onEdit} disabled={withdrawing}>
            Edit
          </DropdownMenuItem>
        ) : null}
        {onWithdraw ? (
          <DropdownMenuItem data-attr="vendor-payment-withdraw" onSelect={onWithdraw} disabled={withdrawing}>
            {withdrawing ? "Withdrawing…" : "Withdraw"}
          </DropdownMenuItem>
        ) : null}
        {onDownload ? (
          <DropdownMenuItem data-attr="vendor-payment-download" onSelect={onDownload}>
            Download
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
