"use client";

import { Mail } from "lucide-react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import {
  formatScheduledSendAt,
  manageableRemindersForCharge,
  type ScheduledPaymentMessage,
} from "@/lib/scheduled-payment-messages";
import { cn } from "@/lib/utils";

function isPaidLedgerRow(row: DemoManagerPaymentLedgerRow): boolean {
  return row.statusLabel === "Paid" || row.balanceDue === "$0.00";
}

/** Upcoming auto-reminder sends shown left of each unpaid charge row. */
export function PaymentScheduledMessagesLead({
  row,
  scheduledMessages,
  onOpenReminders,
  className,
}: {
  row: DemoManagerPaymentLedgerRow;
  scheduledMessages: ScheduledPaymentMessage[];
  onOpenReminders: (row: DemoManagerPaymentLedgerRow) => void;
  className?: string;
}) {
  if (!row.householdChargeId || isPaidLedgerRow(row)) return null;

  const reminders = manageableRemindersForCharge(scheduledMessages, row.householdChargeId)
    .filter((message) => message.status === "scheduled")
    .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());

  if (reminders.length === 0) return null;

  const [nextReminder, ...moreReminders] = reminders;

  return (
    <div
      className={cn("flex shrink-0 flex-col gap-0.5", className)}
      data-attr="payment-scheduled-messages-lead"
    >
      <button
        key={nextReminder.id}
        type="button"
        className="flex max-w-[9.5rem] items-center gap-1 rounded-md border border-border/80 bg-accent/25 px-1.5 py-0.5 text-left text-[10px] leading-snug text-foreground transition-colors hover:bg-accent/50"
        title={`Payment reminder · sends ${formatScheduledSendAt(nextReminder.sendAt)}`}
        data-portal-row-ignore
        data-attr="payment-scheduled-message-chip"
        onClick={(event) => {
          event.stopPropagation();
          onOpenReminders(row);
        }}
      >
        <Mail className="h-3 w-3 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 truncate font-medium">{formatScheduledSendAt(nextReminder.sendAt)}</span>
      </button>
      {moreReminders.length > 0 ? (
        <button
          type="button"
          className="max-w-[9.5rem] truncate px-1.5 text-left text-[10px] font-medium leading-snug text-primary hover:underline"
          data-portal-row-ignore
          data-attr="payment-scheduled-message-more"
          onClick={(event) => {
            event.stopPropagation();
            onOpenReminders(row);
          }}
        >
          +{moreReminders.length} more
        </button>
      ) : null}
    </div>
  );
}
