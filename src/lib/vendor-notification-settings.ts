/**
 * A vendor's own notification settings — the shape, its defaults, and the
 * topic every vendor-facing automated message files under.
 *
 * Before PLAN-0915 the vendor Settings pane had three toggles (New offers,
 * Schedule changes, Payments) that were saved to `vendor_business_profiles`
 * and read by nothing: every sender fanned out regardless. This module is the
 * contract that makes the pane real. `resolveChannels` consults it for every
 * recipient whose profile role is `vendor`, keyed by the message's
 * `VendorNotificationTopic`, so turning "New offers" off actually silences the
 * email and text for an offer (the inbox row is still written — it is the
 * durable record, exactly as it is for residents).
 *
 * Stored in `notification_preferences.row_data.vendor`, the same per-user JSON
 * row residents already use, so there is no migration and no second store.
 * The three legacy booleans stay in `vendor_business_profiles` as a read-time
 * fallback for a vendor who saved the old pane and never touched the new one,
 * and are mirrored back on save so nothing that still reads them goes stale.
 *
 * Pure: no server imports, so the pane and the sender share one normaliser.
 */

export const VENDOR_NOTIFICATION_TOPICS = [
  "offers",
  "schedule",
  "invoices",
  "payments",
  "messages",
  "documents",
  "reviews",
] as const;

export type VendorNotificationTopic = (typeof VENDOR_NOTIFICATION_TOPICS)[number];

export type VendorTopicChannels = { email: boolean; sms: boolean };

export type VendorQuietHours = { enabled: boolean; startHour: number; endHour: number };

export type VendorNotificationSettings = {
  topics: Record<VendorNotificationTopic, VendorTopicChannels>;
  /** Minutes before an offer expires to nudge an unanswered vendor; null = never. */
  offerExpiringLeadMinutes: number | null;
  /** Timing keys ("before:1440") for the vendor's own visit reminders; empty = off. */
  visitReminderTimings: string[];
  /** Whether visit reminders also go by text (email follows `topics.schedule.email`). */
  visitReminderSms: boolean;
  weeklySummary: "off" | "monday";
  /** Vendor's own quiet window for texts, Pacific wall clock. Email is never held. */
  quietHours: VendorQuietHours;
  /** An emergency work order still texts inside quiet hours when this is on. */
  emergencyBypassQuietHours: boolean;
};

export const VENDOR_TOPIC_LABELS: Record<VendorNotificationTopic, string> = {
  offers: "New offers",
  schedule: "Schedule changes",
  invoices: "Invoices",
  payments: "Payments",
  messages: "Messages",
  documents: "Documents",
  reviews: "Reviews",
};

export const VENDOR_OFFER_EXPIRING_LEAD_OPTIONS: { value: number | null; label: string }[] = [
  { value: 240, label: "4 hours before" },
  { value: 120, label: "2 hours before" },
  { value: 60, label: "1 hour before" },
  { value: null, label: "Off" },
];

export const VENDOR_VISIT_REMINDER_OPTIONS: { value: string; timings: string[]; label: string }[] = [
  { value: "1440,60", timings: ["before:1440", "before:60"], label: "1 day, 1 hour before" },
  { value: "60", timings: ["before:60"], label: "1 hour before" },
  { value: "1440", timings: ["before:1440"], label: "1 day before" },
  { value: "", timings: [], label: "Off" },
];

export const DEFAULT_VENDOR_NOTIFICATION_SETTINGS: VendorNotificationSettings = {
  topics: {
    offers: { email: true, sms: true },
    schedule: { email: true, sms: true },
    invoices: { email: true, sms: false },
    payments: { email: true, sms: true },
    messages: { email: true, sms: false },
    documents: { email: true, sms: false },
    reviews: { email: true, sms: false },
  },
  offerExpiringLeadMinutes: 240,
  visitReminderTimings: ["before:1440", "before:60"],
  visitReminderSms: true,
  weeklySummary: "off",
  quietHours: { enabled: true, startHour: 20, endHour: 7 },
  emergencyBypassQuietHours: true,
};

/** The pre-PLAN-0915 toggles on `vendor_business_profiles`. */
export type LegacyVendorNotificationFlags = {
  notifyNewOffers: boolean;
  notifyScheduleChanges: boolean;
  notifyPayments: boolean;
};

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function hour(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const rounded = Math.round(raw);
  return rounded < 0 || rounded > 23 ? fallback : rounded;
}

function channels(raw: unknown, fallback: VendorTopicChannels): VendorTopicChannels {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { email: bool(row.email, fallback.email), sms: bool(row.sms, fallback.sms) };
}

function timingList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = raw.filter((v): v is string => typeof v === "string" && /^before:\d+$/.test(v));
  return [...new Set(out)];
}

/**
 * Normalise a stored blob. When `legacy` is given and the blob has no `topics`,
 * the three old toggles seed the matching topics so a vendor who turned
 * "New offers" off years ago is still not offered.
 */
export function normalizeVendorNotificationSettings(
  raw: unknown,
  legacy?: LegacyVendorNotificationFlags | null,
): VendorNotificationSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const topicsRaw =
    row.topics && typeof row.topics === "object" && !Array.isArray(row.topics)
      ? (row.topics as Record<string, unknown>)
      : null;

  const base = { ...DEFAULT_VENDOR_NOTIFICATION_SETTINGS.topics };
  if (!topicsRaw && legacy) {
    const off = { email: false, sms: false };
    if (!legacy.notifyNewOffers) base.offers = off;
    if (!legacy.notifyScheduleChanges) base.schedule = off;
    if (!legacy.notifyPayments) base.payments = off;
  }
  const topics = {} as Record<VendorNotificationTopic, VendorTopicChannels>;
  for (const topic of VENDOR_NOTIFICATION_TOPICS) {
    topics[topic] = channels(topicsRaw?.[topic], base[topic]);
  }

  const leadRaw = row.offerExpiringLeadMinutes;
  const offerExpiringLeadMinutes =
    leadRaw === null
      ? null
      : typeof leadRaw === "number" && Number.isFinite(leadRaw) && leadRaw >= 5
        ? Math.round(leadRaw)
        : DEFAULT_VENDOR_NOTIFICATION_SETTINGS.offerExpiringLeadMinutes;

  const quietRaw =
    row.quietHours && typeof row.quietHours === "object" && !Array.isArray(row.quietHours)
      ? (row.quietHours as Record<string, unknown>)
      : {};
  const startHour = hour(quietRaw.startHour, DEFAULT_VENDOR_NOTIFICATION_SETTINGS.quietHours.startHour);
  const endHour = hour(quietRaw.endHour, DEFAULT_VENDOR_NOTIFICATION_SETTINGS.quietHours.endHour);

  return {
    topics,
    offerExpiringLeadMinutes,
    visitReminderTimings: timingList(row.visitReminderTimings, DEFAULT_VENDOR_NOTIFICATION_SETTINGS.visitReminderTimings),
    visitReminderSms: bool(row.visitReminderSms, DEFAULT_VENDOR_NOTIFICATION_SETTINGS.visitReminderSms),
    weeklySummary: row.weeklySummary === "monday" ? "monday" : "off",
    quietHours: {
      // A zero-length window silences nothing; store it as off.
      enabled: bool(quietRaw.enabled, DEFAULT_VENDOR_NOTIFICATION_SETTINGS.quietHours.enabled) && startHour !== endHour,
      startHour,
      endHour,
    },
    emergencyBypassQuietHours: bool(
      row.emergencyBypassQuietHours,
      DEFAULT_VENDOR_NOTIFICATION_SETTINGS.emergencyBypassQuietHours,
    ),
  };
}

/** The legacy booleans a normalised settings blob implies, for mirroring on save. */
export function legacyFlagsFromVendorNotificationSettings(
  settings: VendorNotificationSettings,
): LegacyVendorNotificationFlags {
  const on = (c: VendorTopicChannels) => c.email || c.sms;
  return {
    notifyNewOffers: on(settings.topics.offers),
    notifyScheduleChanges: on(settings.topics.schedule),
    notifyPayments: on(settings.topics.payments),
  };
}

/** Is `hour` inside the vendor's quiet window? Wraps midnight like the manager's. */
export function isVendorQuietHour(quietHours: VendorQuietHours, hour: number): boolean {
  if (!quietHours.enabled) return false;
  const { startHour, endHour } = quietHours;
  if (startHour === endHour) return false;
  if (startHour > endHour) return hour >= startHour || hour < endHour;
  return hour >= startHour && hour < endHour;
}

/**
 * Which vendor topic an action event files under. Kept here (pure) so the
 * emitter and the retry path derive the same answer from the stored
 * `(domain, event_type)` pair, never from anything that has to be persisted.
 */
export function vendorTopicForEvent(domain: string, event: string): VendorNotificationTopic {
  if (domain === "work_order") {
    if (["vendor_offered", "offer_expiring", "offer_expired", "offer_filled", "vendor_declined"].includes(event)) return "offers";
    if (["invoiced", "invoice_approved", "invoice_disputed"].includes(event)) return "invoices";
    if (event === "paid") return "payments";
    if (event === "rated") return "reviews";
    return "schedule";
  }
  if (domain === "payment") return "payments";
  return "messages";
}
