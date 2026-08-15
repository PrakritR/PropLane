import {
  chargeDueLabel,
  householdChargeDueDate,
  isUnpaidHouseholdCharge,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { lateFeePolicyFromSubmission } from "@/lib/payment-policy";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  type ManagerAutomationSettings,
  type PaymentReminderKind,
  type ScheduledMessageOverride,
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  isLegacyReminderCancelled,
  legacyPaymentReminderDedupIds,
  paymentReminderDedupId,
  scheduledOverrideId,
  setDateReminderIsoFromKey,
  setDateReminderKey,
} from "@/lib/payment-automation-settings";
import { buildReminderContent } from "@/lib/payment-reminder-email";

export type ScheduledPaymentMessageStatus = "scheduled" | "cancelled" | "sent";

export type ScheduledPaymentMessage = {
  id: string;
  chargeId: string;
  kind: PaymentReminderKind;
  daysBeforeDue: number | null;
  sendAt: string;
  visibleFrom: string;
  dueDate: string | null;
  dueDateLabel: string;
  residentName: string;
  residentEmail: string;
  chargeTitle: string;
  propertyLabel: string;
  balanceDue: string;
  subject: string;
  body: string;
  status: ScheduledPaymentMessageStatus;
  managerUserId: string;
  typeLabel: string;
  /** Present when this row bundles several charges into one send slot. */
  bundledChargeIds?: string[];
};

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return startOfLocalDay(next);
}

function resolveSendAt(computed: Date, override?: ScheduledMessageOverride): Date {
  if (override?.customSendAt) {
    const parsed = new Date(override.customSendAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return computed;
}

/** Display label for when a scheduled message will send (date + time). */
export function formatScheduledSendAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((startOfLocalDay(b).getTime() - startOfLocalDay(a).getTime()) / (1000 * 60 * 60 * 24));
}

export function scheduledMessageListId(input: {
  chargeId: string;
  kind: PaymentReminderKind;
  daysBeforeDue: number | null;
  sendAt: Date;
}): string {
  const dayPart = input.daysBeforeDue == null ? "na" : String(input.daysBeforeDue);
  return ["sched", input.chargeId, input.kind, dayPart, dateKey(input.sendAt)].join("|");
}

export function computePreDueSendAt(dueDate: Date, daysBeforeDue: number): Date {
  return addDays(dueDate, -daysBeforeDue);
}

function formatSetDateIso(iso: string | null): string | null {
  if (!iso) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const d = new Date(year!, month! - 1, day!, 12, 0, 0, 0);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function typeLabel(kind: PaymentReminderKind, daysBeforeDue: number | null): string {
  if (kind === "pre_due") {
    const d = daysBeforeDue ?? 0;
    return d === 1 ? "1 day before due" : `${d} days before due`;
  }
  if (kind === "same_day") return "Due day";
  if (kind === "post_due") {
    const d = daysBeforeDue ?? 1;
    return d === 1 ? "1 day after due" : `${d} days after due`;
  }
  if (kind === "overdue_daily") return "Every day late";
  if (kind === "set_date") {
    const formatted = formatSetDateIso(setDateReminderIsoFromKey(daysBeforeDue));
    return formatted ? `On ${formatted}` : "On set date";
  }
  return "Late fee notice";
}

export function scheduledReminderShortLabel(kind: PaymentReminderKind, daysBeforeDue: number | null): string {
  if (kind === "pre_due") {
    const d = daysBeforeDue ?? 0;
    return d === 1 ? "1 day before" : `${d} days before`;
  }
  if (kind === "same_day") return "Due date";
  if (kind === "post_due") {
    const d = daysBeforeDue ?? 1;
    return d === 1 ? "1 day after" : `${d} days after`;
  }
  if (kind === "overdue_daily") return "Every day late";
  if (kind === "set_date") return "Set date";
  return "Notice";
}

/** Generic labels for inbox schedule UI (not payment-specific). */
export function inboxScheduleTypeLabel(kind: PaymentReminderKind, daysBeforeDue: number | null): string {
  if (kind === "pre_due") {
    const d = daysBeforeDue ?? 0;
    return d === 1 ? "1 day before send" : `${d} days before send`;
  }
  if (kind === "same_day") return "Send on due date";
  if (kind === "post_due") {
    const d = daysBeforeDue ?? 1;
    return d === 1 ? "1 day after due" : `${d} days after due`;
  }
  if (kind === "overdue_daily") return "Every day late";
  if (kind === "set_date") return "On set date";
  return "Notice";
}

function isUpcomingScheduleMessage(message: ScheduledPaymentMessage, now: Date): boolean {
  if (message.status === "sent") return false;
  if (message.status === "scheduled" && startOfLocalDay(new Date(message.sendAt)).getTime() < startOfLocalDay(now).getTime()) {
    return false;
  }
  return startOfLocalDay(new Date(message.sendAt)).getTime() >= startOfLocalDay(now).getTime();
}

/** Whether a projected payment reminder should appear in the manager schedule tab right now. */
export function isScheduledPaymentMessageVisibleInTab(
  message: ScheduledPaymentMessage,
  settings: ManagerAutomationSettings,
  now = new Date(),
): boolean {
  if (!isUpcomingScheduleMessage(message, now)) return false;
  if (message.status !== "scheduled" && message.status !== "cancelled") return false;
  if (settings.scheduleVisibilityMode === "all") return true;
  return startOfLocalDay(now).getTime() >= startOfLocalDay(new Date(message.visibleFrom)).getTime();
}

export function filterScheduledPaymentMessagesForVisibility(
  messages: ScheduledPaymentMessage[],
  settings: ManagerAutomationSettings,
  now = new Date(),
): ScheduledPaymentMessage[] {
  return messages.filter((message) => isScheduledPaymentMessageVisibleInTab(message, settings, now));
}

function isVisible(
  settings: ManagerAutomationSettings,
  sendAt: Date,
  visibleFrom: Date,
  now: Date,
): boolean {
  if (settings.scheduleVisibilityMode === "all") return true;
  return startOfLocalDay(now).getTime() >= startOfLocalDay(visibleFrom).getTime();
}

function resolveOverride(
  overrides: Map<string, ScheduledMessageOverride>,
  managerUserId: string,
  chargeId: string,
  kind: PaymentReminderKind,
  daysBeforeDue: number | null,
): ScheduledMessageOverride | undefined {
  return overrides.get(
    scheduledOverrideId({ managerUserId, chargeId, kind, daysBeforeDue }),
  );
}

function isSent(sentIds: Set<string>, kind: PaymentReminderKind, chargeId: string, daysBeforeDue: number | null, todayKey: string): boolean {
  const candidates =
    kind === "overdue_daily"
      ? [paymentReminderDedupId({ kind, chargeId, todayKey })]
      : legacyPaymentReminderDedupIds({ kind, chargeId, daysBeforeDue: daysBeforeDue ?? undefined });
  return candidates.some((id) => sentIds.has(id));
}

export function projectScheduledPaymentMessages(input: {
  managerUserId: string;
  charges: HouseholdCharge[];
  settings?: ManagerAutomationSettings;
  overrides?: Map<string, ScheduledMessageOverride>;
  sentDedupIds?: Set<string>;
  listingByPropertyId?: Map<string, ManagerListingSubmissionV1>;
  managerName?: string;
  now?: Date;
  includeHidden?: boolean;
}): ScheduledPaymentMessage[] {
  const settings = input.settings ?? DEFAULT_MANAGER_AUTOMATION_SETTINGS;
  const overrides = input.overrides ?? new Map<string, ScheduledMessageOverride>();
  const sentIds = input.sentDedupIds ?? new Set<string>();
  const listings = input.listingByPropertyId ?? new Map<string, ManagerListingSubmissionV1>();
  const now = input.now ?? new Date();
  const todayKey = dateKey(now);
  const managerName = input.managerName?.trim() || "Your property manager";
  const rows: ScheduledPaymentMessage[] = [];

  for (const charge of input.charges) {
    if (!isUnpaidHouseholdCharge(charge)) continue;
    if (charge.residentEmail.trim().toLowerCase().endsWith("@axis.local")) continue;

    const dueDate = householdChargeDueDate(charge);

    const dueDateLabel = chargeDueLabel(charge);
    const dueStart = dueDate ? startOfLocalDay(dueDate) : null;
    const daysUntilDue = dueStart ? daysBetween(startOfLocalDay(now), dueStart) : 0;

    const baseParams = {
      residentName: charge.residentName || "Resident",
      residentEmail: charge.residentEmail.trim().toLowerCase(),
      chargeTitle: charge.title,
      balanceDue: charge.balanceLabel,
      propertyLabel: charge.propertyLabel,
      managerName,
      dueDateLabel,
      daysUntilDue: Math.max(0, daysUntilDue),
      lateFeeAmount: "",
      graceDays: settings.lateFeeNoticeDaysAfterDue,
    };

    if (dueStart) {
    for (const daysBeforeDue of settings.preDueReminderDays) {
      if (daysBeforeDue <= 0) continue;

      const override = resolveOverride(overrides, input.managerUserId, charge.id, "pre_due", daysBeforeDue);
      const effectiveDays = override?.customDaysBeforeDue ?? daysBeforeDue;
      const computedSendAt = computePreDueSendAt(dueStart, effectiveDays);
      const effectiveSendAt = resolveSendAt(computedSendAt, override);
      if (effectiveSendAt.getTime() > dueStart.getTime()) continue;

      const visibleFrom = addDays(effectiveSendAt, -settings.scheduleVisibilityDays);
      if (!input.includeHidden && !isVisible(settings, effectiveSendAt, visibleFrom, now)) continue;
      if (!input.includeHidden && effectiveSendAt.getTime() < startOfLocalDay(now).getTime()) continue;

      const cancelled =
        override?.cancelled === true ||
        isLegacyReminderCancelled(charge.cancelledReminders, "pre_due", effectiveDays);
      const sent = isSent(sentIds, "pre_due", charge.id, effectiveDays, todayKey);
      const content = buildReminderContent({
        kind: "pre_due",
        daysBeforeDue: effectiveDays,
        settings,
        override,
        params: { ...baseParams, daysUntilDue: Math.max(0, daysBetween(effectiveSendAt, dueStart)) },
      });

      rows.push({
        id: scheduledMessageListId({ chargeId: charge.id, kind: "pre_due", daysBeforeDue: effectiveDays, sendAt: effectiveSendAt }),
        chargeId: charge.id,
        kind: "pre_due",
        daysBeforeDue: effectiveDays,
        sendAt: effectiveSendAt.toISOString(),
        visibleFrom: visibleFrom.toISOString(),
        dueDate: dueStart.toISOString(),
        dueDateLabel,
        residentName: charge.residentName || "Resident",
        residentEmail: charge.residentEmail.trim().toLowerCase(),
        chargeTitle: charge.title,
        propertyLabel: charge.propertyLabel,
        balanceDue: charge.balanceLabel,
        subject: content.subject,
        body: content.body,
        status: sent ? "sent" : cancelled ? "cancelled" : "scheduled",
        managerUserId: input.managerUserId,
        typeLabel: typeLabel("pre_due", effectiveDays),
      });
    }

    if (settings.sameDayReminderEnabled && daysUntilDue >= 0) {
      const computedSendAt = dueStart;
      const override = resolveOverride(overrides, input.managerUserId, charge.id, "same_day", null);
      const sendAt = resolveSendAt(computedSendAt, override);
      const visibleFrom = addDays(sendAt, -settings.scheduleVisibilityDays);
      const showRow =
        input.includeHidden ||
        (isVisible(settings, sendAt, visibleFrom, now) && sendAt.getTime() >= startOfLocalDay(now).getTime());
      if (showRow) {
        const cancelled =
          override?.cancelled === true || isLegacyReminderCancelled(charge.cancelledReminders, "same_day");
        const sent = isSent(sentIds, "same_day", charge.id, null, todayKey);
        const content = buildReminderContent({
          kind: "same_day",
          settings,
          override,
          params: { ...baseParams, daysUntilDue: 0 },
        });
        rows.push({
          id: scheduledMessageListId({ chargeId: charge.id, kind: "same_day", daysBeforeDue: null, sendAt }),
          chargeId: charge.id,
          kind: "same_day",
          daysBeforeDue: null,
          sendAt: sendAt.toISOString(),
          visibleFrom: visibleFrom.toISOString(),
          dueDate: dueStart.toISOString(),
          dueDateLabel,
          residentName: charge.residentName || "Resident",
          residentEmail: charge.residentEmail.trim().toLowerCase(),
          chargeTitle: charge.title,
          propertyLabel: charge.propertyLabel,
          balanceDue: charge.balanceLabel,
          subject: content.subject,
          body: content.body,
          status: sent ? "sent" : cancelled ? "cancelled" : "scheduled",
          managerUserId: input.managerUserId,
          typeLabel: typeLabel("same_day", null),
        });
      }
    }

    for (const daysAfterDue of settings.postDueReminderDays) {
      if (daysAfterDue <= 0) continue;
      const computedSendAt = addDays(dueStart, daysAfterDue);
      const override = resolveOverride(overrides, input.managerUserId, charge.id, "post_due", daysAfterDue);
      const sendAt = resolveSendAt(computedSendAt, override);
      const visibleFrom = addDays(sendAt, -settings.scheduleVisibilityDays);
      if (!input.includeHidden && !isVisible(settings, sendAt, visibleFrom, now)) continue;
      if (!input.includeHidden && sendAt.getTime() < startOfLocalDay(now).getTime()) continue;

      const cancelled = override?.cancelled === true;
      const sent = isSent(sentIds, "post_due", charge.id, daysAfterDue, todayKey);
      const content = buildReminderContent({
        kind: "post_due",
        daysBeforeDue: daysAfterDue,
        settings,
        override,
        params: { ...baseParams, daysUntilDue: -daysAfterDue },
      });
      rows.push({
        id: scheduledMessageListId({ chargeId: charge.id, kind: "post_due", daysBeforeDue: daysAfterDue, sendAt }),
        chargeId: charge.id,
        kind: "post_due",
        daysBeforeDue: daysAfterDue,
        sendAt: sendAt.toISOString(),
        visibleFrom: visibleFrom.toISOString(),
        dueDate: dueStart.toISOString(),
        dueDateLabel,
        residentName: charge.residentName || "Resident",
        residentEmail: charge.residentEmail.trim().toLowerCase(),
        chargeTitle: charge.title,
        propertyLabel: charge.propertyLabel,
        balanceDue: charge.balanceLabel,
        subject: content.subject,
        body: content.body,
        status: sent ? "sent" : cancelled ? "cancelled" : "scheduled",
        managerUserId: input.managerUserId,
        typeLabel: typeLabel("post_due", daysAfterDue),
      });
    }

    if (daysUntilDue < 0 && settings.overdueDailyEnabled) {
      const daysPastDue = Math.abs(daysUntilDue);
      if (daysPastDue >= settings.overdueDailyStartDays) {
        const computedSendAt = startOfLocalDay(now);
        const override = resolveOverride(overrides, input.managerUserId, charge.id, "overdue_daily", null);
        const sendAt = resolveSendAt(computedSendAt, override);
        const visibleFrom = addDays(sendAt, -settings.scheduleVisibilityDays);
        const showRow =
          input.includeHidden ||
          (isVisible(settings, sendAt, visibleFrom, now) && sendAt.getTime() >= startOfLocalDay(now).getTime());
        if (showRow) {
          const cancelled =
            override?.cancelled === true || isLegacyReminderCancelled(charge.cancelledReminders, "overdue_daily");
          const sent = isSent(sentIds, "overdue_daily", charge.id, null, todayKey);
          const content = buildReminderContent({
            kind: "overdue_daily",
            settings,
            override,
            params: { ...baseParams, daysUntilDue: -daysPastDue },
          });
          rows.push({
            id: scheduledMessageListId({ chargeId: charge.id, kind: "overdue_daily", daysBeforeDue: null, sendAt }),
            chargeId: charge.id,
            kind: "overdue_daily",
            daysBeforeDue: null,
            sendAt: sendAt.toISOString(),
            visibleFrom: visibleFrom.toISOString(),
            dueDate: dueStart.toISOString(),
            dueDateLabel,
            residentName: charge.residentName || "Resident",
            residentEmail: charge.residentEmail.trim().toLowerCase(),
            chargeTitle: charge.title,
            propertyLabel: charge.propertyLabel,
            balanceDue: charge.balanceLabel,
            subject: content.subject,
            body: content.body,
            status: sent ? "sent" : cancelled ? "cancelled" : "scheduled",
            managerUserId: input.managerUserId,
            typeLabel: typeLabel("overdue_daily", null),
          });
        }
      }
    }

    const listing = listings.get(charge.propertyId);
    const policy = lateFeePolicyFromSubmission(listing);
    const lateEligible = ["rent", "utilities", "first_month_rent", "prorated_rent", "prorated_utilities", "move_in_fee"].includes(
      charge.kind,
    );
    if (lateEligible && settings.lateFeeNoticeEnabled && policy.enabled && daysUntilDue < 0) {
      const graceDays = policy.graceDays;
      const computedSendAt = addDays(dueStart, graceDays);
      const override = resolveOverride(overrides, input.managerUserId, charge.id, "late_fee", null);
      const sendAt = resolveSendAt(computedSendAt, override);
      if (sendAt.getTime() >= startOfLocalDay(now).getTime() || daysBetween(dueStart, now) >= graceDays) {
        const visibleFrom = addDays(sendAt, -settings.scheduleVisibilityDays);
        const showRow =
          input.includeHidden ||
          (isVisible(settings, sendAt, visibleFrom, now) && sendAt.getTime() >= startOfLocalDay(now).getTime());
        if (showRow) {
          const cancelled = override?.cancelled === true;
          const lateFeeId = `hc_late_fee_${charge.id}`;
          const sent = sentIds.has(`late_fee_notice_${lateFeeId}`);
          const content = buildReminderContent({
            kind: "late_fee",
            settings,
            override,
            params: {
              ...baseParams,
              lateFeeAmount: policy.amountLabel,
              graceDays,
              daysUntilDue: -daysBetween(dueStart, now),
            },
          });
          rows.push({
            id: scheduledMessageListId({ chargeId: charge.id, kind: "late_fee", daysBeforeDue: null, sendAt }),
            chargeId: charge.id,
            kind: "late_fee",
            daysBeforeDue: null,
            sendAt: sendAt.toISOString(),
            visibleFrom: visibleFrom.toISOString(),
            dueDate: dueStart.toISOString(),
            dueDateLabel,
            residentName: charge.residentName || "Resident",
            residentEmail: charge.residentEmail.trim().toLowerCase(),
            chargeTitle: charge.title,
            propertyLabel: charge.propertyLabel,
            balanceDue: policy.amountLabel,
            subject: content.subject,
            body: content.body,
            status: sent ? "sent" : cancelled ? "cancelled" : "scheduled",
            managerUserId: input.managerUserId,
            typeLabel: typeLabel("late_fee", null),
          });
        }
      }
    }
    } else if (settings.overdueDailyEnabled) {
      // Charges without a parseable due date (e.g. "Before lease signing",
      // "Before approval") are payable immediately — give them the daily
      // follow-up stream, anchored to when the charge was created.
      const createdRaw = new Date(charge.createdAt);
      const createdStart = Number.isNaN(createdRaw.getTime()) ? startOfLocalDay(now) : startOfLocalDay(createdRaw);
      const firstSend = addDays(createdStart, Math.max(0, settings.overdueDailyStartDays));
      const computedSendAt = firstSend.getTime() > startOfLocalDay(now).getTime() ? firstSend : startOfLocalDay(now);
      const override = resolveOverride(overrides, input.managerUserId, charge.id, "overdue_daily", null);
      const sendAt = resolveSendAt(computedSendAt, override);
      const visibleFrom = addDays(sendAt, -settings.scheduleVisibilityDays);
      if (input.includeHidden || isVisible(settings, sendAt, visibleFrom, now)) {
        const cancelled =
          override?.cancelled === true || isLegacyReminderCancelled(charge.cancelledReminders, "overdue_daily");
        const sent = isSent(sentIds, "overdue_daily", charge.id, null, todayKey);
        const content = buildReminderContent({
          kind: "overdue_daily",
          settings,
          override,
          params: { ...baseParams, daysUntilDue: 0 },
        });
        rows.push({
          id: scheduledMessageListId({ chargeId: charge.id, kind: "overdue_daily", daysBeforeDue: null, sendAt }),
          chargeId: charge.id,
          kind: "overdue_daily",
          daysBeforeDue: null,
          sendAt: sendAt.toISOString(),
          visibleFrom: visibleFrom.toISOString(),
          dueDate: null,
          dueDateLabel,
          residentName: charge.residentName || "Resident",
          residentEmail: charge.residentEmail.trim().toLowerCase(),
          chargeTitle: charge.title,
          propertyLabel: charge.propertyLabel,
          balanceDue: charge.balanceLabel,
          subject: content.subject,
          body: content.body,
          status: sent ? "sent" : cancelled ? "cancelled" : "scheduled",
          managerUserId: input.managerUserId,
          typeLabel: typeLabel("overdue_daily", null),
        });
      }
    }

    // One-off reminders on specific calendar dates: the manager-wide dates from
    // settings plus any dates added for this charge (stored as overrides).
    const setDateKeys = new Set<number>();
    for (const iso of settings.setDateReminders) {
      const key = setDateReminderKey(iso);
      if (key != null) setDateKeys.add(key);
    }
    const chargeOverridePrefix = `smo_${input.managerUserId.slice(0, 8)}_${charge.id}_set_date_`;
    for (const overrideKey of overrides.keys()) {
      if (!overrideKey.startsWith(chargeOverridePrefix)) continue;
      const parsedKey = Number(overrideKey.slice(chargeOverridePrefix.length));
      if (setDateReminderIsoFromKey(parsedKey)) setDateKeys.add(parsedKey);
    }
    for (const dateNumKey of [...setDateKeys].sort((a, b) => a - b)) {
      const iso = setDateReminderIsoFromKey(dateNumKey);
      if (!iso) continue;
      const [year, month, day] = iso.split("-").map(Number);
      const computedSendAt = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
      const override = resolveOverride(overrides, input.managerUserId, charge.id, "set_date", dateNumKey);
      const sendAt = resolveSendAt(computedSendAt, override);
      if (!input.includeHidden && sendAt.getTime() < startOfLocalDay(now).getTime()) continue;
      const visibleFrom = addDays(sendAt, -settings.scheduleVisibilityDays);
      if (!input.includeHidden && !isVisible(settings, sendAt, visibleFrom, now)) continue;

      const cancelled = override?.cancelled === true;
      const sent = isSent(sentIds, "set_date", charge.id, dateNumKey, todayKey);
      const content = buildReminderContent({
        kind: "set_date",
        settings,
        override,
        params: { ...baseParams, daysUntilDue: dueStart ? Math.max(0, daysBetween(sendAt, dueStart)) : 0 },
      });
      rows.push({
        id: scheduledMessageListId({ chargeId: charge.id, kind: "set_date", daysBeforeDue: dateNumKey, sendAt }),
        chargeId: charge.id,
        kind: "set_date",
        daysBeforeDue: dateNumKey,
        sendAt: sendAt.toISOString(),
        visibleFrom: visibleFrom.toISOString(),
        dueDate: dueStart ? dueStart.toISOString() : null,
        dueDateLabel,
        residentName: charge.residentName || "Resident",
        residentEmail: charge.residentEmail.trim().toLowerCase(),
        chargeTitle: charge.title,
        propertyLabel: charge.propertyLabel,
        balanceDue: charge.balanceLabel,
        subject: content.subject,
        body: content.body,
        status: sent ? "sent" : cancelled ? "cancelled" : "scheduled",
        managerUserId: input.managerUserId,
        typeLabel: typeLabel("set_date", dateNumKey),
      });
    }
  }

  const visibleRows = input.includeHidden ? rows : rows.filter((row) => isUpcomingScheduleMessage(row, now));
  return visibleRows.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

/** Drop projected reminders for charges that are no longer unpaid (e.g. just marked paid in-session). */
export function filterScheduledPaymentMessagesForUnpaidCharges(
  messages: ScheduledPaymentMessage[],
  charges: HouseholdCharge[],
): ScheduledPaymentMessage[] {
  const paidChargeIds = new Set(
    charges.filter((charge) => !isUnpaidHouseholdCharge(charge)).map((charge) => charge.id),
  );
  if (paidChargeIds.size === 0) return messages;
  return messages.filter((message) => !paidChargeIds.has(message.chargeId));
}

export function shouldSendScheduledMessage(message: ScheduledPaymentMessage, now = new Date()): boolean {
  if (message.status !== "scheduled") return false;
  return dateKey(new Date(message.sendAt)) === dateKey(now);
}

export function upcomingScheduledForCharge(
  messages: ScheduledPaymentMessage[],
  chargeId: string,
  limit = 3,
): ScheduledPaymentMessage[] {
  return manageableRemindersForCharge(messages, chargeId, limit).filter((m) => m.status === "scheduled");
}

/**
 * Upcoming scheduled and cancelled reminders for a charge (excludes already
 * sent and past-dated sends). This reflects the manager's full default schedule
 * for the charge and is intentionally NOT gated by the Inbox schedule-visibility
 * window (that setting only controls what surfaces in Inbox → Schedule). Feed it
 * the unfiltered message list (`useScheduledPaymentMessages({ includeHidden: true })`).
 */
export function manageableRemindersForCharge(
  messages: ScheduledPaymentMessage[],
  chargeId: string,
  limit = 12,
  now = new Date(),
): ScheduledPaymentMessage[] {
  const today = startOfLocalDay(now).getTime();
  return messages
    .filter(
      (m) =>
        m.chargeId === chargeId &&
        (m.status === "scheduled" || m.status === "cancelled") &&
        startOfLocalDay(new Date(m.sendAt)).getTime() >= today,
    )
    .slice(0, limit);
}
