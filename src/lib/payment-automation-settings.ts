import type { SupabaseClient } from "@supabase/supabase-js";

export type PaymentReminderKind = "pre_due" | "same_day" | "post_due" | "overdue_daily" | "late_fee" | "set_date";

export type ScheduleVisibilityMode = "all" | "days_before_send";

export type ReminderTemplate = {
  subject: string;
  body: string;
};

export type ManagerAutomationSettings = {
  preDueReminderDays: number[];
  /** One-time reminders after the due date (legacy; day 1 migrates to overdueDailyEnabled). */
  postDueReminderDays: number[];
  /** One-off reminders sent on specific calendar dates (ISO YYYY-MM-DD), for every eligible charge. */
  setDateReminders: string[];
  scheduleVisibilityMode: ScheduleVisibilityMode;
  scheduleVisibilityDays: number;
  overdueDailyEnabled: boolean;
  overdueDailyStartDays: number;
  lateFeeNoticeEnabled: boolean;
  lateFeeNoticeDaysAfterDue: number;
  sameDayReminderEnabled: boolean;
  /**
   * Opt-in (default OFF): when a new pending tour inquiry arrives, PropLane
   * proposes confirming it into the first matching open slot as an approval item
   * the manager must accept. It NEVER books or emails the tenant on its own —
   * approval flows through the same preview/confirm gate as every other write.
   */
  proposeTourConfirmations: boolean;
  /** Confirmed tour reminders sent before the tour start time. */
  tourReminderEnabled: boolean;
  tourReminderMinutesBefore: number;
  tourReminderDeliverViaEmail: boolean;
  tourReminderDeliverViaSms: boolean;
  paymentReminderDeliverViaEmail: boolean;
  paymentReminderDeliverViaSms: boolean;
  templates: {
    preDue: ReminderTemplate;
    overdue: ReminderTemplate;
    lateFee: ReminderTemplate;
    tourReminder: ReminderTemplate;
  };
};

export const DEFAULT_PRE_DUE_REMINDER_DAYS = [3, 2, 1] as const;
export const DEFAULT_POST_DUE_REMINDER_DAYS = [] as const;

export const PAYMENT_AUTOMATION_SETTINGS_EVENT = "axis:payment-automation-settings";

export const DEFAULT_TOUR_REMINDER_MINUTES_BEFORE = 30;

export const DEFAULT_TOUR_REMINDER_TEMPLATE: ReminderTemplate = {
  subject: "Reminder: your tour at {propertyTitle}",
  body: [
    "Hi {guestName},",
    "",
    "This is a friendly reminder about your upcoming property tour.",
    "",
    "When: {tourTime}",
    "{propertyLine}",
    "{instructionsLine}",
    "",
    "We look forward to seeing you!",
    "",
    "{managerName}",
    "PropLane",
  ].join("\n"),
};

export const DEFAULT_MANAGER_AUTOMATION_SETTINGS: ManagerAutomationSettings = {
  preDueReminderDays: [...DEFAULT_PRE_DUE_REMINDER_DAYS],
  postDueReminderDays: [...DEFAULT_POST_DUE_REMINDER_DAYS],
  setDateReminders: [],
  scheduleVisibilityMode: "days_before_send",
  scheduleVisibilityDays: 3,
  overdueDailyEnabled: true,
  overdueDailyStartDays: 1,
  lateFeeNoticeEnabled: false,
  lateFeeNoticeDaysAfterDue: 5,
  sameDayReminderEnabled: true,
  proposeTourConfirmations: false,
  tourReminderEnabled: true,
  tourReminderMinutesBefore: DEFAULT_TOUR_REMINDER_MINUTES_BEFORE,
  tourReminderDeliverViaEmail: true,
  tourReminderDeliverViaSms: false,
  paymentReminderDeliverViaEmail: true,
  paymentReminderDeliverViaSms: false,
  templates: {
    preDue: {
      subject: "Payment due {daysUntilDuePhrase}: {chargeTitle}",
      body: [
        "Hi {residentName},",
        "",
        "This is a reminder that your {chargeTitle} payment is due {daysUntilDuePhrase} ({dueDate}).",
        "",
        "Amount due: {balanceDue}",
        "{propertyLine}",
        "",
        "{residentPortalLogin}",
        "",
        "If you have any questions, please don't hesitate to reach out.",
        "",
        "{managerName}",
        "PropLane Portal",
      ].join("\n"),
    },
    overdue: {
      subject: "Overdue payment reminder: {chargeTitle}",
      body: [
        "Hi {residentName},",
        "",
        "This is a reminder that your {chargeTitle} payment is overdue ({dueDate}).",
        "",
        "Amount due: {balanceDue}",
        "{propertyLine}",
        "",
        "Please submit payment as soon as possible to avoid additional late fees.",
        "",
        "{residentPortalLogin}",
        "",
        "{managerName}",
        "PropLane Portal",
      ].join("\n"),
    },
    lateFee: {
      subject: "Late fee added: {chargeTitle}",
      body: [
        "Hi {residentName},",
        "",
        "A late payment fee of {lateFeeAmount} has been added because {chargeTitle} is more than {graceDays} day(s) past due.",
        "{propertyLine}",
        "",
        "{residentPortalLogin}",
        "",
        "{managerName}",
        "PropLane Portal",
      ].join("\n"),
    },
    tourReminder: DEFAULT_TOUR_REMINDER_TEMPLATE,
  },
};

export type ScheduledMessageOverride = {
  cancelled?: boolean;
  /** Set when a reminder was auto-cancelled because the charge was marked paid. */
  cancelledBecausePaid?: boolean;
  customSubject?: string;
  customBody?: string;
  customDaysBeforeDue?: number;
  /** ISO timestamp — overrides the computed send time for this reminder slot. */
  customSendAt?: string;
};

function normalizePostDueDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_POST_DUE_REMINDER_DAYS];
  const nums = raw
    .map((v) => Math.round(Number(v)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 30);
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  return unique.length ? unique : [...DEFAULT_POST_DUE_REMINDER_DAYS];
}

/** Human-readable summary of the automated reminder cadence. */
export function formatStandardReminderSchedule(settings: Pick<
  ManagerAutomationSettings,
  "preDueReminderDays" | "sameDayReminderEnabled" | "postDueReminderDays" | "overdueDailyEnabled"
>): string {
  const parts: string[] = [];
  const pre = [...settings.preDueReminderDays].sort((a, b) => b - a);
  if (pre.length) parts.push(`${pre.join(", ")} days before`);
  if (settings.sameDayReminderEnabled) parts.push("due date");
  const post = [...settings.postDueReminderDays].sort((a, b) => a - b);
  if (post.length) parts.push(`${post.join(", ")} day(s) after`);
  if (settings.overdueDailyEnabled) parts.push("every day late");
  return parts.length ? parts.join(" · ") : "Off";
}

function normalizePreDueDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PRE_DUE_REMINDER_DAYS];
  if (raw.length === 0) return [];
  const nums = raw
    .map((v) => Math.round(Number(v)))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 60);
  const unique = [...new Set(nums)].sort((a, b) => b - a);
  return unique.length ? unique : [...DEFAULT_PRE_DUE_REMINDER_DAYS];
}

function normalizeSetDateReminders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const dates = raw
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
    .filter((v) => {
      const [year, month, day] = v.split("-").map(Number);
      const d = new Date(year!, month! - 1, day!);
      return d.getFullYear() === year && d.getMonth() === month! - 1 && d.getDate() === day;
    });
  return [...new Set(dates)].sort().slice(0, 24);
}

/** Encode an ISO date (YYYY-MM-DD) as the numeric key stored in days_before_due for set_date reminders. */
export function setDateReminderKey(isoDate: string): number | null {
  const normalized = normalizeSetDateReminders([isoDate]);
  if (!normalized.length) return null;
  return Number(normalized[0]!.replaceAll("-", ""));
}

/** Decode a set_date numeric key (YYYYMMDD) back to an ISO date, or null when malformed. */
export function setDateReminderIsoFromKey(key: number | null | undefined): string | null {
  if (key == null || !Number.isFinite(key)) return null;
  const raw = String(Math.round(key));
  if (!/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return normalizeSetDateReminders([iso])[0] ?? null;
}

function normalizeTemplate(raw: unknown, fallback: ReminderTemplate): ReminderTemplate {
  if (!raw || typeof raw !== "object") return fallback;
  const row = raw as Record<string, unknown>;
  const subject = typeof row.subject === "string" && row.subject.trim() ? row.subject.trim() : fallback.subject;
  const body = typeof row.body === "string" && row.body.trim() ? row.body.trim() : fallback.body;
  return { subject, body };
}

export function normalizeManagerAutomationSettings(raw: unknown): ManagerAutomationSettings {
  const base = DEFAULT_MANAGER_AUTOMATION_SETTINGS;
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const templatesRaw = row.templates && typeof row.templates === "object" ? (row.templates as Record<string, unknown>) : {};

  const visibilityMode = row.scheduleVisibilityMode === "all" ? "all" : "days_before_send";
  const visibilityDays = Math.max(
    0,
    Math.min(30, Math.round(Number(row.scheduleVisibilityDays ?? base.scheduleVisibilityDays) || base.scheduleVisibilityDays)),
  );

  let postDueReminderDays = normalizePostDueDays(row.postDueReminderDays);
  // Opt-in: an explicitly saved value (true or false) always wins. No saved
  // setting at all defaults to disabled, not enabled.
  let overdueDailyEnabled = row.overdueDailyEnabled === true;
  let overdueDailyStartDays = Math.max(
    0,
    Math.min(30, Math.round(Number(row.overdueDailyStartDays ?? base.overdueDailyStartDays) || base.overdueDailyStartDays)),
  );

  // Legacy one-time "1 day after due" → daily overdue starting day 1, unless
  // the manager explicitly turned overdue-daily off.
  if (postDueReminderDays.includes(1) && row.overdueDailyEnabled !== false) {
    overdueDailyEnabled = true;
    overdueDailyStartDays = Math.min(overdueDailyStartDays, 1);
    postDueReminderDays = postDueReminderDays.filter((d) => d !== 1);
  }

  return {
    preDueReminderDays: normalizePreDueDays(row.preDueReminderDays),
    postDueReminderDays,
    setDateReminders: normalizeSetDateReminders(row.setDateReminders),
    scheduleVisibilityMode: visibilityMode,
    scheduleVisibilityDays: visibilityDays,
    overdueDailyEnabled,
    overdueDailyStartDays,
    // Opt-in like proposeTourConfirmations below: late-fee notices create real
    // charges, so no saved value must never auto-enable them.
    lateFeeNoticeEnabled: row.lateFeeNoticeEnabled === true,
    lateFeeNoticeDaysAfterDue: Math.max(
      0,
      Math.min(30, Math.round(Number(row.lateFeeNoticeDaysAfterDue ?? base.lateFeeNoticeDaysAfterDue) || base.lateFeeNoticeDaysAfterDue)),
    ),
    sameDayReminderEnabled: row.sameDayReminderEnabled !== false,
    // Opt-in: OFF unless the manager explicitly saved `true`. Same idiom as
    // overdueDailyEnabled — no saved value must never auto-enable a proposal.
    proposeTourConfirmations: row.proposeTourConfirmations === true,
    tourReminderEnabled: row.tourReminderEnabled !== false,
    tourReminderMinutesBefore: Math.max(
      5,
      Math.min(
        24 * 60,
        Math.round(Number(row.tourReminderMinutesBefore ?? base.tourReminderMinutesBefore) || base.tourReminderMinutesBefore),
      ),
    ),
    tourReminderDeliverViaEmail: row.tourReminderDeliverViaEmail !== false,
    tourReminderDeliverViaSms: row.tourReminderDeliverViaSms === true,
    paymentReminderDeliverViaEmail: row.paymentReminderDeliverViaEmail !== false,
    paymentReminderDeliverViaSms: row.paymentReminderDeliverViaSms === true,
    templates: {
      preDue: normalizeTemplate(templatesRaw.preDue, base.templates.preDue),
      overdue: normalizeTemplate(templatesRaw.overdue, base.templates.overdue),
      lateFee: normalizeTemplate(templatesRaw.lateFee, base.templates.lateFee),
      tourReminder: normalizeTemplate(templatesRaw.tourReminder, base.templates.tourReminder),
    },
  };
}

export async function loadManagerAutomationSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerAutomationSettings> {
  const { data } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  return normalizeManagerAutomationSettings(data?.row_data ?? null);
}

export async function saveManagerAutomationSettings(
  db: SupabaseClient,
  managerUserId: string,
  settings: ManagerAutomationSettings,
): Promise<ManagerAutomationSettings> {
  const normalized = normalizeManagerAutomationSettings(settings);
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: normalized,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}

export function scheduledOverrideId(input: {
  managerUserId: string;
  chargeId: string;
  kind: PaymentReminderKind;
  daysBeforeDue?: number | null;
}): string {
  const dayPart = input.daysBeforeDue == null ? "na" : String(input.daysBeforeDue);
  return `smo_${input.managerUserId.slice(0, 8)}_${input.chargeId}_${input.kind}_${dayPart}`;
}

export async function loadScheduledMessageOverrides(
  db: SupabaseClient,
  managerUserId: string,
): Promise<Map<string, ScheduledMessageOverride>> {
  const { data } = await db
    .from("scheduled_message_overrides")
    .select("id, charge_id, reminder_kind, days_before_due, row_data")
    .eq("manager_user_id", managerUserId);

  const map = new Map<string, ScheduledMessageOverride>();
  for (const row of data ?? []) {
    const key = scheduledOverrideId({
      managerUserId,
      chargeId: String(row.charge_id),
      kind: row.reminder_kind as PaymentReminderKind,
      daysBeforeDue: row.days_before_due as number | null,
    });
    map.set(key, (row.row_data ?? {}) as ScheduledMessageOverride);
  }
  return map;
}

export async function upsertScheduledMessageOverride(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    chargeId: string;
    kind: PaymentReminderKind;
    daysBeforeDue?: number | null;
    patch: ScheduledMessageOverride;
  },
): Promise<void> {
  const id = scheduledOverrideId(input);
  const { data: existing } = await db.from("scheduled_message_overrides").select("row_data").eq("id", id).maybeSingle();
  const merged = { ...((existing?.row_data ?? {}) as ScheduledMessageOverride), ...input.patch };
  const { error } = await db.from("scheduled_message_overrides").upsert(
    {
      id,
      manager_user_id: input.managerUserId,
      charge_id: input.chargeId,
      reminder_kind: input.kind,
      days_before_due: input.daysBeforeDue ?? null,
      row_data: merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw error;
}

/** Legacy slot strings on household charges map to new reminder keys. */
export function legacySlotToKind(slot: string): { kind: PaymentReminderKind; daysBeforeDue?: number } | null {
  if (slot === "overdue_daily") return { kind: "overdue_daily" };
  if (slot === "12h") return { kind: "same_day" };
  const match = /^(\d+)d$/.exec(slot);
  if (match) return { kind: "pre_due", daysBeforeDue: Number(match[1]) };
  return null;
}

export function isLegacyReminderCancelled(
  cancelledReminders: string[] | undefined,
  kind: PaymentReminderKind,
  daysBeforeDue?: number,
): boolean {
  if (!cancelledReminders?.length) return false;
  if (kind === "overdue_daily") return cancelledReminders.includes("overdue_daily");
  if (kind === "same_day") return cancelledReminders.includes("12h");
  if (kind === "pre_due" && daysBeforeDue != null) {
    return cancelledReminders.includes(`${daysBeforeDue}d`);
  }
  return false;
}

export function paymentReminderDedupId(input: {
  kind: PaymentReminderKind;
  chargeId: string;
  daysBeforeDue?: number;
  todayKey?: string;
}): string {
  if (input.kind === "overdue_daily") {
    return `payment_reminder_overdue_${input.todayKey ?? "day"}_${input.chargeId}`;
  }
  if (input.kind === "same_day") {
    return `payment_reminder_same_day_${input.chargeId}`;
  }
  if (input.kind === "post_due") {
    const days = input.daysBeforeDue ?? 1;
    return `payment_reminder_post_${days}d_${input.chargeId}`;
  }
  if (input.kind === "late_fee") {
    return `late_fee_notice_${input.chargeId}`;
  }
  if (input.kind === "set_date") {
    return `payment_reminder_setdate_${input.daysBeforeDue ?? 0}_${input.chargeId}`;
  }
  const days = input.daysBeforeDue ?? 0;
  const modern = `payment_reminder_pre_${days}d_${input.chargeId}`;
  return modern;
}

export function legacyPaymentReminderDedupIds(input: {
  kind: PaymentReminderKind;
  chargeId: string;
  daysBeforeDue?: number;
}): string[] {
  const ids = [paymentReminderDedupId(input)];
  if (input.kind === "pre_due" && input.daysBeforeDue === 7) ids.push(`payment_reminder_7d_${input.chargeId}`);
  if (input.kind === "pre_due" && input.daysBeforeDue === 5) ids.push(`payment_reminder_5d_${input.chargeId}`);
  if (input.kind === "pre_due" && input.daysBeforeDue === 3) ids.push(`payment_reminder_3d_${input.chargeId}`);
  if (input.kind === "same_day") ids.push(`payment_reminder_12h_${input.chargeId}`);
  return ids;
}
