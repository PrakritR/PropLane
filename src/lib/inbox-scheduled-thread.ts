import {
  isUpcomingScheduledInboxMessage,
  isResidentOriginatedScheduledMessage,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages";
import {
  formatScheduledSendAt,
  type ScheduledPaymentMessage,
} from "@/lib/scheduled-payment-messages";
import { combineScheduledPaymentMessages } from "@/lib/combined-payment-reminders";

/**
 * A scheduled / automated message surfaced INLINE inside a person's
 * conversation thread (marked "Scheduled · sends <when>"), replacing the old
 * standalone Schedule table. The manager sees past + pending + scheduled
 * communication with one person in one place.
 */
export type ThreadScheduledItem = {
  id: string;
  source: "manual" | "automation";
  sendAt: string;
  /** Human "sends <when>" label. */
  sendLabel: string;
  subject: string;
  body: string;
  /** Short context line (automation charge title / property; manual is generic). */
  meta?: string;
  /**
   * Whether the MANAGER may edit this row's content inline. False for
   * resident-originated manual rows (managers may cancel but not rewrite them,
   * mirroring `updateScheduledInboxMessage`'s server-side guard). Automation and
   * manager-authored manual rows are editable.
   */
  editable: boolean;
  /**
   * Channel the message will send on. Email today; the field exists so an SMS /
   * WhatsApp / Gmail scheduled item tags into the SAME person-thread once those
   * channels come online, rather than a parallel list.
   */
  channel: "email" | "sms";
  deliverViaEmail: boolean;
  deliverViaSms: boolean;
};

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Map one manual scheduled-inbox row to the inline thread card shape. */
export function threadScheduledItemFromManualMessage(
  message: ScheduledInboxMessageRecord,
): ThreadScheduledItem {
  return {
    id: message.id,
    source: "manual",
    sendAt: message.sendAt,
    sendLabel: formatScheduledSendAt(message.sendAt),
    subject: message.subject,
    body: message.body,
    editable: !isResidentOriginatedScheduledMessage(message),
    channel: message.deliverViaSms && !message.deliverViaEmail ? "sms" : "email",
    deliverViaEmail: message.deliverViaEmail !== false,
    deliverViaSms: message.deliverViaSms === true,
  };
}

/**
 * The manager's own payment-reminder delivery settings, in the shape the card
 * needs. A reminder with no override of its own sends on THESE channels, so the
 * card has to display them rather than an invented email-only default.
 *
 * Structurally typed against `ManagerAutomationSettings` so this module stays
 * free of the settings module (and its Supabase import) — the callers already
 * hold the settings object.
 */
export type ScheduledAutomationChannelDefaults = {
  deliverViaEmail: boolean;
  deliverViaSms: boolean;
};

export function automationChannelDefaultsFromSettings(
  settings:
    | { paymentReminderDeliverViaEmail?: boolean; paymentReminderDeliverViaSms?: boolean }
    | null
    | undefined,
): ScheduledAutomationChannelDefaults | undefined {
  if (!settings) return undefined;
  return {
    deliverViaEmail: settings.paymentReminderDeliverViaEmail !== false,
    deliverViaSms: settings.paymentReminderDeliverViaSms === true,
  };
}

/** Map one automated payment-reminder row to the inline thread card shape. */
export function threadScheduledItemFromAutomationMessage(
  message: ScheduledPaymentMessage,
  defaults?: ScheduledAutomationChannelDefaults,
): ThreadScheduledItem {
  /*
    A reminder the manager has not re-pointed carries no channel of its own, so
    what it WILL do is whatever the automation's delivery settings say. Show
    that. Only when the caller has no settings to hand does this fall back to
    the email-only shape the card has always displayed — presentation, never a
    stored decision.
  */
  const deliverViaEmail = message.deliverViaEmail ?? defaults?.deliverViaEmail ?? true;
  const deliverViaSms = message.deliverViaSms ?? defaults?.deliverViaSms ?? false;
  return {
    id: message.id,
    source: "automation",
    sendAt: message.sendAt,
    sendLabel: formatScheduledSendAt(message.sendAt),
    subject: message.subject,
    body: message.body,
    meta:
      message.bundledChargeIds && message.bundledChargeIds.length > 1
        ? `${message.bundledChargeIds.length} payments${message.propertyLabel ? ` · ${message.propertyLabel}` : ""}`
        : [message.chargeTitle, message.propertyLabel].filter(Boolean).join(" · ") || undefined,
    editable: true,
    channel: deliverViaSms && !deliverViaEmail ? "sms" : "email",
    deliverViaEmail,
    deliverViaSms,
  };
}

/**
 * Upcoming, still-scheduled messages addressed to `recipientEmail`, newest send
 * last, ready to render as inline "Scheduled" cards in that person's thread.
 * Cancelled/sent rows are dropped (the thread shows what is *pending*), matching
 * the Schedule table's `isUpcomingScheduledInboxMessage` gate. Pure + testable.
 */
export function scheduledItemsForRecipient(
  recipientEmail: string,
  manual: ScheduledInboxMessageRecord[],
  automation: ScheduledPaymentMessage[],
  automationDefaults?: ScheduledAutomationChannelDefaults,
): ThreadScheduledItem[] {
  const target = normalizeEmail(recipientEmail);
  if (!target) return [];

  const items: ThreadScheduledItem[] = [];

  for (const message of manual) {
    if (message.status !== "scheduled") continue;
    if (!isUpcomingScheduledInboxMessage(message.sendAt, message.status)) continue;
    if (normalizeEmail(message.recipientEmail) !== target) continue;
    items.push(threadScheduledItemFromManualMessage(message));
  }

  for (const message of combineScheduledPaymentMessages(automation)) {
    if (message.status !== "scheduled") continue;
    if (!isUpcomingScheduledInboxMessage(message.sendAt, message.status)) continue;
    if (normalizeEmail(message.residentEmail) !== target) continue;
    items.push(threadScheduledItemFromAutomationMessage(message, automationDefaults));
  }

  return items.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}
