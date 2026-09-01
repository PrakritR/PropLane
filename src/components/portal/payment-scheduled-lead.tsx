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
    .slice(0, 4);

  if (reminders.length === 0) return null;

  return (
    <div
      className={cn("flex flex-col gap-0.5 shrink-0", className)}
      data-attr="payment-scheduled-messages-lead"
    >
      {reminders.map((message) => (
        <button
          key={message.id}
          type="button"
          className="flex max-w-[9.5rem] items-center gap-1 rounded-md border border-border/80 bg-accent/25 px-1.5 py-0.5 text-left text-[10px] leading-tight text-foreground transition-colors hover:bg-accent/50"
          title={`Payment reminder · sends ${formatScheduledSendAt(message.sendAt)}`}
          data-portal-row-ignore
          data-attr="payment-scheduled-message-chip"
          onClick={(event) => {
            event.stopPropagation();
            onOpenReminders(row);
          }}
        >
          <Mail className="h-3 w-3 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 truncate font-medium">{formatScheduledSendAt(message.sendAt)}</span>
        </button>
      ))}
    </div>
  );
}
