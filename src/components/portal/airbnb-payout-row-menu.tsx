"use client";

import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";

/** The ⋯ on an Airbnb payout row: Mark paid (only while the payout is due) and Open booking. */
export function AirbnbPayoutRowMenu({ onMarkPaid, onOpenBooking }: { onMarkPaid?: () => void; onOpenBooking?: () => void }) {
  if (!onMarkPaid && !onOpenBooking) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        aria-label="Airbnb payout actions"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-portal-row-ignore
        data-attr="airbnb-payout-row-menu"
      >
        <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onMarkPaid ? (
          <DropdownMenuItem data-attr="airbnb-payout-mark-paid" onSelect={onMarkPaid}>
            Mark paid
          </DropdownMenuItem>
        ) : null}
        {onOpenBooking ? (
          <DropdownMenuItem data-attr="airbnb-payout-open-booking" onSelect={onOpenBooking}>
            Open booking
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
