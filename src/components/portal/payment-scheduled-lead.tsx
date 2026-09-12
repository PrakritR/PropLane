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

  /*
   * ONE chip and, at most, one "+N more" link.
   *
   * A charge that rides along in three other charges' reminder emails used to
   * draw a line for each of them — "Same email · 3 charges · Sep 18" three
   * times over — so a row with four reminders stood 200px tall and the ledger
   * read as a wall of grey type. The next send is the fact the manager scans
   * for; everything else is one tap away in the reminders sheet.
   */
  const next = primaryReminders[0] ?? bundledIntoOthers[0]!;
  const more = reminders.length - 1;
  const nextIsBundled = next.chargeId !== chargeId;

  return (
    <div
      // Every chip is a real tap target on a phone (PRP-351): 28 px tall with a
      // 4 px gap, so a thumb lands on ONE reminder rather than the row or the
      // line above. The type stays 10 px; the box grows, not the text.
      className={cn("flex w-[13.25rem] shrink-0 items-center gap-1", className)}
      data-attr="payment-scheduled-messages-lead"
    >
      <button
        key={next.id}
        type="button"
        className="flex h-7 max-w-[9.5rem] items-center gap-1 rounded-md border border-border/80 bg-accent/25 px-1.5 text-left text-[10px] leading-none text-foreground transition-colors hover:bg-accent/50"
        title={nextIsBundled ? `In the same email as another charge · ${reminderChipTitle(next)}` : reminderChipTitle(next)}
        data-portal-row-ignore
        data-attr={nextIsBundled ? "payment-scheduled-message-bundled" : "payment-scheduled-message-chip"}
        onClick={(event) => {
          event.stopPropagation();
          onOpenReminders(row);
        }}
      >
        <Mail className="h-3 w-3 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 truncate font-medium">
          {scheduledPaymentMessageChargeIds(next).length > 1
            ? `${scheduledPaymentMessageChargeIds(next).length} charges · ${formatScheduledSendAt(next.sendAt)}`
            : formatScheduledSendAt(next.sendAt)}
        </span>
      </button>
      {more > 0 ? (
        <button
          type="button"
          className="flex h-7 shrink-0 items-center whitespace-nowrap px-1 text-left text-[10px] font-medium leading-none text-primary hover:underline"
          data-portal-row-ignore
          data-attr="payment-scheduled-message-more"
          // Every row's link reads "+N more" on screen; the accessible name says
          // whose reminders, so a screen reader is not handed twenty identical links.
          aria-label={`${more} more scheduled reminders for ${row.residentName} · ${row.chargeTitle}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenReminders(row);
          }}
        >
          +{more} more
        </button>
      ) : null}
    </div>
  );
}
