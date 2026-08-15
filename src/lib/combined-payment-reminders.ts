import { expandResidentPortalLoginTemplatePlaceholder } from "@/lib/resident-portal-login-copy";
import type { PaymentReminderKind } from "@/lib/payment-automation-settings";
import {
  formatDaysUntilDuePhrase,
  formatDaysUntilDueShort,
} from "@/lib/payment-reminder-email";
import type { ScheduledPaymentMessage } from "@/lib/scheduled-payment-messages";

const COMBINABLE_KINDS = new Set<PaymentReminderKind>([
  "pre_due",
  "same_day",
  "post_due",
  "overdue_daily",
  "set_date",
]);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sendAtBundleKey(sendAt: string): string {
  const d = new Date(sendAt);
  if (Number.isNaN(d.getTime())) return sendAt;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function scheduledPaymentMessageBundleKey(message: ScheduledPaymentMessage): string {
  const dayPart = message.daysBeforeDue == null ? "na" : String(message.daysBeforeDue);
  return [
    normalizeEmail(message.residentEmail),
    message.kind,
    dayPart,
    sendAtBundleKey(message.sendAt),
    message.status,
  ].join("|");
}

export function scheduledPaymentMessageChargeIds(message: ScheduledPaymentMessage): string[] {
  return message.bundledChargeIds?.length ? message.bundledChargeIds : [message.chargeId];
}

export function combinedScheduledMessageListId(input: {
  residentEmail: string;
  kind: PaymentReminderKind;
  daysBeforeDue: number | null;
  sendAt: string;
  chargeIds: string[];
}): string {
  const dayPart = input.daysBeforeDue == null ? "na" : String(input.daysBeforeDue);
  const sendKey = sendAtBundleKey(input.sendAt);
  const chargePart = [...input.chargeIds].sort().join(",");
  return ["sched", "bundle", normalizeEmail(input.residentEmail), input.kind, dayPart, sendKey, chargePart].join("|");
}

export function parseCombinedScheduledMessageListId(id: string): {
  residentEmail: string;
  kind: PaymentReminderKind;
  daysBeforeDue: number | null;
  sendAtKey: string;
  chargeIds: string[];
} | null {
  const parts = id.split("|");
  if (parts.length < 7 || parts[0] !== "sched" || parts[1] !== "bundle") return null;
  const kind = parts[3] as PaymentReminderKind;
  if (!["pre_due", "same_day", "post_due", "overdue_daily", "late_fee", "set_date"].includes(kind)) return null;
  const dayPart = parts[4]!;
  const daysBeforeDue = dayPart === "na" ? null : Number(dayPart);
  const chargeIds = parts.slice(6).join("|").split(",").filter(Boolean);
  if (!chargeIds.length) return null;
  return {
    residentEmail: parts[2]!,
    kind,
    daysBeforeDue: Number.isFinite(daysBeforeDue) ? daysBeforeDue : null,
    sendAtKey: parts[5]!,
    chargeIds,
  };
}

function daysUntilDueForBundle(messages: ScheduledPaymentMessage[]): number {
  const first = messages[0]!;
  if (first.kind === "same_day") return 0;
  if (first.kind === "pre_due") return first.daysBeforeDue ?? 0;
  if (first.kind === "post_due") return -(first.daysBeforeDue ?? 1);
  if (first.kind === "overdue_daily") {
    const due = first.dueDate ? new Date(first.dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) return -1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    due.setHours(0, 0, 0, 0);
    return Math.floor((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }
  return 0;
}

/** Build one concise subject/body for several charges that share a send slot. */
export function buildCombinedPaymentReminderContent(
  messages: ScheduledPaymentMessage[],
): Pick<ScheduledPaymentMessage, "subject" | "body" | "typeLabel" | "chargeTitle" | "balanceDue" | "propertyLabel"> {
  const sorted = [...messages].sort((a, b) => a.chargeTitle.localeCompare(b.chargeTitle));
  const first = sorted[0]!;
  const count = sorted.length;
  const daysUntilDue = daysUntilDueForBundle(sorted);
  const daysPhrase = formatDaysUntilDuePhrase(daysUntilDue);
  const daysLabel = formatDaysUntilDueShort(daysUntilDue);

  const propertyLabels = [...new Set(sorted.map((m) => m.propertyLabel.trim()).filter(Boolean))];
  const propertyLine = propertyLabels.length === 1 ? `Property: ${propertyLabels[0]}` : "";

  const chargeLines = sorted.map((m) => {
    const due = m.dueDateLabel?.trim();
    const dueSuffix = due && due !== "—" ? ` (due ${due})` : "";
    return `• ${m.chargeTitle} — ${m.balanceDue}${dueSuffix}`;
  });

  const totalBalances = sorted.map((m) => m.balanceDue).join(", ");

  let subject: string;
  let intro: string;
  if (first.kind === "overdue_daily" || first.kind === "post_due") {
    subject = count === 1 ? first.subject : `Overdue payment reminder (${count} payments)`;
    intro =
      count === 1
        ? `This is a reminder that your ${first.chargeTitle} payment is overdue (${first.dueDateLabel}).`
        : `This is a reminder that you have ${count} overdue payments:`;
  } else if (first.kind === "same_day" || (first.kind === "pre_due" && daysUntilDue === 0)) {
    subject = count === 1 ? first.subject : `Payment due today (${count} payments)`;
    intro =
      count === 1
        ? `This is a reminder that your ${first.chargeTitle} payment is due today (${first.dueDateLabel}).`
        : `This is a reminder that you have ${count} payments due today:`;
  } else {
    subject =
      count === 1
        ? first.subject
        : `Payment due ${daysPhrase} (${count} payments)`;
    intro =
      count === 1
        ? `This is a reminder that your ${first.chargeTitle} payment is due ${daysPhrase} (${first.dueDateLabel}).`
        : `This is a reminder that you have ${count} payments due ${daysPhrase}:`;
  }

  const bodyParts = [
    `Hi ${first.residentName},`,
    "",
    intro,
    "",
    ...(count === 1
      ? [`Amount due: ${first.balanceDue}`, ...(propertyLine ? [propertyLine] : [])]
      : [...chargeLines, ...(propertyLine ? ["", propertyLine] : [])]),
    "",
    "Sign in to your resident portal to review and pay your outstanding charges.",
    "",
    "If you have any questions, please don't hesitate to reach out.",
    "",
    first.body.split("\n").find((line) => line.includes("PropLane")) ?? "PropLane Portal",
  ];

  const body = expandResidentPortalLoginTemplatePlaceholder(bodyParts.join("\n"), {
    residentEmail: first.residentEmail,
    afterLoginHint: "payments",
  });

  return {
    subject,
    body,
    typeLabel: first.typeLabel,
    chargeTitle: count === 1 ? first.chargeTitle : `${count} payments`,
    balanceDue: count === 1 ? first.balanceDue : totalBalances,
    propertyLabel: propertyLabels.length === 1 ? propertyLabels[0]! : "",
  };
}

function canCombineGroup(messages: ScheduledPaymentMessage[]): boolean {
  if (messages.length < 2) return false;
  const first = messages[0]!;
  if (!COMBINABLE_KINDS.has(first.kind)) return false;
  return messages.every(
    (m) =>
      m.kind === first.kind &&
      m.daysBeforeDue === first.daysBeforeDue &&
      m.sendAt === first.sendAt &&
      normalizeEmail(m.residentEmail) === normalizeEmail(first.residentEmail) &&
      m.status === first.status &&
      m.managerUserId === first.managerUserId,
  );
}

/**
 * Merge per-charge reminders that share the same resident, send time, and reminder
 * slot into one concise scheduled message. Per-charge rows are preserved when they
 * do not have siblings in the same slot.
 */
export function combineScheduledPaymentMessages(
  messages: ScheduledPaymentMessage[],
): ScheduledPaymentMessage[] {
  const buckets = new Map<string, ScheduledPaymentMessage[]>();
  const passthrough: ScheduledPaymentMessage[] = [];

  for (const message of messages) {
    if (!COMBINABLE_KINDS.has(message.kind)) {
      passthrough.push(message);
      continue;
    }
    const key = scheduledPaymentMessageBundleKey(message);
    const list = buckets.get(key) ?? [];
    list.push(message);
    buckets.set(key, list);
  }

  const combined: ScheduledPaymentMessage[] = [];
  for (const group of buckets.values()) {
    if (!canCombineGroup(group)) {
      combined.push(...group);
      continue;
    }
    const sorted = [...group].sort((a, b) => a.chargeTitle.localeCompare(b.chargeTitle));
    const first = sorted[0]!;
    const chargeIds = sorted.map((m) => m.chargeId);
    const content = buildCombinedPaymentReminderContent(sorted);
    combined.push({
      ...first,
      id: combinedScheduledMessageListId({
        residentEmail: first.residentEmail,
        kind: first.kind,
        daysBeforeDue: first.daysBeforeDue,
        sendAt: first.sendAt,
        chargeIds,
      }),
      chargeId: chargeIds[0]!,
      bundledChargeIds: chargeIds,
      ...content,
    });
  }

  return [...passthrough, ...combined].sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}
