"use client";

import { Mail } from "lucide-react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import {
  formatScheduledSendAt,
  manageableRemindersForCharge,
  scheduledPaymentMessageChargeIds,
  type ScheduledPaymentMessage,
} from "@/lib/scheduled-payment-messages";
import { cn } from "@/lib/utils";

function isPaidLedgerRow(row: DemoManagerPaymentLedgerRow): boolean {
  return row.statusLabel === "Paid" || row.balanceDue === "$0.00";
}

function reminderChipTitle(message: ScheduledPaymentMessage): string {
  const when = formatScheduledSendAt(message.sendAt);
  const bundled = scheduledPaymentMessageChargeIds(message);
  if (bundled.length > 1) {
    return `Combined payment reminder (${bundled.length} charges) · sends ${when}`;
  }
  return `Payment reminder · sends ${when}`;
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

  const chargeId = row.householdChargeId;
  const reminders = manageableRemindersForCharge(scheduledMessages, chargeId)
    .filter((message) => message.status === "scheduled")
    .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());

  if (reminders.length === 0) return null;

  const primaryReminders = reminders.filter((message) => message.chargeId === chargeId);
  const bundledIntoOthers = reminders.filter(
    (message) => message.chargeId !== chargeId && scheduledPaymentMessageChargeIds(message).includes(chargeId),
  );

  const [nextPrimary, ...morePrimary] = primaryReminders;

  return (
    <div
      className={cn("flex shrink-0 flex-col gap-0.5", className)}
      data-attr="payment-scheduled-messages-lead"
    >
      {nextPrimary ? (
        <button
          key={nextPrimary.id}
          type="button"
          className="flex max-w-[9.5rem] items-center gap-1 rounded-md border border-border/80 bg-accent/25 px-1.5 py-0.5 text-left text-[10px] leading-snug text-foreground transition-colors hover:bg-accent/50"
          title={reminderChipTitle(nextPrimary)}
          data-portal-row-ignore
          data-attr="payment-scheduled-message-chip"
          onClick={(event) => {
            event.stopPropagation();
            onOpenReminders(row);
          }}
        >
          <Mail className="h-3 w-3 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 truncate font-medium">
            {scheduledPaymentMessageChargeIds(nextPrimary).length > 1
              ? `${scheduledPaymentMessageChargeIds(nextPrimary).length} charges · ${formatScheduledSendAt(nextPrimary.sendAt)}`
              : formatScheduledSendAt(nextPrimary.sendAt)}
          </span>
        </button>
      ) : null}
      {morePrimary.length > 0 ? (
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
          +{morePrimary.length} more
        </button>
      ) : null}
      {bundledIntoOthers.map((message) => {
        const bundledCount = scheduledPaymentMessageChargeIds(message).length;
        return (
          <button
            key={message.id}
            type="button"
            className="max-w-[9.5rem] truncate px-1.5 text-left text-[10px] leading-snug text-muted hover:text-foreground hover:underline"
            title={reminderChipTitle(message)}
            data-portal-row-ignore
            data-attr="payment-scheduled-message-bundled"
            onClick={(event) => {
              event.stopPropagation();
              onOpenReminders(row);
            }}
          >
            Same email · {bundledCount} charges · {formatScheduledSendAt(message.sendAt)}
          </button>
        );
      })}
    </div>
  );
}
