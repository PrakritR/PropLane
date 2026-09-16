import type { SupabaseClient } from "@supabase/supabase-js";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { isVendorQuietHour, type VendorNotificationTopic } from "@/lib/vendor-notification-settings";

export type ResolveChannelsOptions = {
  /**
   * Which vendor Settings row gates this message. Ignored for every other
   * role. Absent on a vendor recipient, the category picks a sensible topic
   * (`payments` → payments, `messages` → messages, anything else → schedule).
   */
  vendorTopic?: VendorNotificationTopic;
  /**
   * A vendor's own visit reminder: gated by their "Visit reminders" row (off =
   * nothing outward, text per its own toggle) rather than a topic.
   */
  vendorVisitReminder?: boolean;
  /** An emergency: a vendor's quiet-hours bypass applies. */
  urgent?: boolean;
  now?: Date;
};

/**
 * Notification categories a user can tune independently. `account` covers
 * security/account-critical notices (verification, password/2FA, billing
 * failures) and is intentionally the only category that defaults SMS on and
 * forces SMS at resolve time — a user cannot silence account-safety alerts.
 */
export type NotificationCategory =
  | "messages"
  | "leases"
  | "payments"
  | "maintenance"
  | "applications"
  | "voice_calls"
  | "account";

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  "messages",
  "leases",
  "payments",
  "maintenance",
  "applications",
  "voice_calls",
  "account",
];

export type ChannelPreference = {
  inbox: boolean;
  email: boolean;
  sms: boolean;
};

export type NotificationPreferences = Record<NotificationCategory, ChannelPreference>;

export type ResolvedChannels = {
  inbox: boolean;
  email: boolean;
  sms: boolean;
};

/**
 * Resident/vendor channel matrix: every category delivers to inbox, email, and
 * SMS. Manager recipients are routed separately through the manager alert
 * destination and topic preferences in `manager-notification-routing.server`.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  messages: { inbox: true, email: true, sms: true },
  leases: { inbox: true, email: true, sms: true },
  payments: { inbox: true, email: true, sms: true },
  maintenance: { inbox: true, email: true, sms: true },
  applications: { inbox: true, email: true, sms: true },
  // A phone call is the one channel a manager cannot scroll back through, so
  // the summary defaults to reaching them everywhere — including SMS on their
  // real mobile, which is usually where they already are when a call lands.
  voice_calls: { inbox: true, email: true, sms: true },
  account: { inbox: true, email: true, sms: true },
};

function normalizeChannel(raw: unknown, fallback: ChannelPreference): ChannelPreference {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    // Inbox is always on — it is the durable record of every notification and
    // is not user-suppressible.
    inbox: true,
    email: typeof row.email === "boolean" ? row.email : fallback.email,
    sms: typeof row.sms === "boolean" ? row.sms : fallback.sms,
  };
}

export function normalizeNotificationPreferences(raw: unknown): NotificationPreferences {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as NotificationPreferences;
  for (const category of NOTIFICATION_CATEGORIES) {
    out[category] = normalizeChannel(row[category], DEFAULT_NOTIFICATION_PREFERENCES[category]);
  }
  return out;
}

export async function loadNotificationPreferences(
  db: SupabaseClient,
  userId: string,
): Promise<NotificationPreferences> {
  const { data } = await db
    .from("notification_preferences")
    .select("row_data")
    .eq("user_id", userId)
    .maybeSingle();
  return normalizeNotificationPreferences(data?.row_data ?? null);
}

export async function saveNotificationPreferences(
  db: SupabaseClient,
  userId: string,
  prefs: unknown,
): Promise<NotificationPreferences> {
  const normalized = normalizeNotificationPreferences(prefs);
  const { error } = await db.from("notification_preferences").upsert(
    {
      user_id: userId,
      row_data: normalized,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  return normalized;
}

type RecipientProfile = {
  phone?: string | null;
  phone_verified_at?: string | null;
  role?: string | null;
  sms_from_number?: string | null;
  sms_forward_inbound?: boolean | null;
};

/**
 * Resolve the effective delivery channels for a given recipient + category,
 * combining the recipient's saved preferences with hard delivery constraints:
 *
 * - For residents/vendors, `inbox` is ALWAYS true (durable record).
 * - For managers, `inbox` represents an Assistant notification; the underlying
 *   communication/audit record remains durable even when that alert is quiet.
 * - `email` follows the stored preference (default when no row exists).
 * - `sms` requires a phone on the profile (collected at signup) that has not
 *   texted STOP. Verification OTP is not required for resident delivery.
 *
 * Pass `recipientProfile` to avoid a profile fetch when the caller already has
 * the phone + verification columns loaded.
 */
export async function resolveChannels(
  db: SupabaseClient,
  userId: string,
  category: NotificationCategory,
  recipientProfile?: RecipientProfile | null,
  options?: ResolveChannelsOptions,
): Promise<ResolvedChannels> {
  // Resident/vendor delivery remains always-on. Manager recipients branch to
  // the preference-aware Assistant/SMS router below.

  let profile = recipientProfile ?? null;
  if (!profile) {
    const { data } = await db
      .from("profiles")
      .select("phone, phone_verified_at, role, sms_from_number, sms_forward_inbound")
      .eq("id", userId)
      .maybeSingle();
    profile = (data as RecipientProfile | null) ?? null;
  }

  const role = String(profile?.role ?? "").trim().toLowerCase();
  if (["manager", "owner", "pro", "admin"].includes(role)) {
    const { resolveManagerNotificationChannels } = await import(
      "@/lib/manager-notification-routing.server"
    );
    return resolveManagerNotificationChannels(db, userId, category, profile);
  }

  // A vendor's own Settings → Notifications pane decides, per topic. Before
  // PLAN-0915 those toggles were saved and read by nobody; this branch is what
  // makes them mean something. Inbox stays on as the durable record.
  if (role === "vendor") {
    return resolveVendorChannels(db, userId, category, profile, options);
  }

  // Load the recipient's saved preferences for this category. Fail OPEN on a
  // read error — deliberately the opposite of the usual fail-closed rule
  // elsewhere in this codebase: a broken preferences lookup must never be the
  // reason a resident silently stops getting mail, so an unreadable table
  // falls back to today's default (email on, sms following only the
  // phone/consent gate below) rather than suppressing delivery.
  let categoryPreference: ChannelPreference = DEFAULT_NOTIFICATION_PREFERENCES[category];
  try {
    const prefs = await loadNotificationPreferences(db, userId);
    categoryPreference = prefs[category];
  } catch {
    categoryPreference = DEFAULT_NOTIFICATION_PREFERENCES[category];
  }

  const phone = String(profile?.phone ?? "").trim();
  // Consent wins over preference, always: a saved sms:true never overrides a
  // STOP. Only check the opt-out (an extra DB/lookup call) when a phone is on
  // file AND the saved preference wants SMS in the first place.
  let sms = false;
  if (phone && categoryPreference.sms) {
    sms = !(await isPhoneOptedOut(db, phone));
  }

  return {
    // Inbox is always on for residents/vendors — the durable record is not
    // user-suppressible, even by a legacy row that somehow stored inbox: false
    // (normalizeNotificationPreferences already clamps this, but pin it here
    // too as the final word).
    inbox: true,
    email: categoryPreference.email,
    sms,
  };
}

async function resolveVendorChannels(
  db: SupabaseClient,
  userId: string,
  category: NotificationCategory,
  profile: RecipientProfile | null,
  options?: ResolveChannelsOptions,
): Promise<ResolvedChannels> {
  const topic: VendorNotificationTopic =
    options?.vendorTopic ?? (category === "payments" ? "payments" : category === "messages" ? "messages" : "schedule");
  let settings;
  try {
    const { loadVendorNotificationSettings } = await import("@/lib/vendor-notification-settings.server");
    settings = await loadVendorNotificationSettings(db, userId);
  } catch {
    // Fail open like the resident path: an unreadable settings row must never
    // be the reason a vendor stops hearing about work.
    const { DEFAULT_VENDOR_NOTIFICATION_SETTINGS } = await import("@/lib/vendor-notification-settings");
    settings = DEFAULT_VENDOR_NOTIFICATION_SETTINGS;
  }
  const pref = options?.vendorVisitReminder
    ? settings.visitReminderTimings.length === 0
      ? { email: false, sms: false }
      : { email: settings.topics.schedule.email, sms: settings.visitReminderSms }
    : settings.topics[topic];
  // Account-safety notices are never silenced, for vendors as for everyone.
  const email = category === "account" ? true : pref.email;
  const phone = String(profile?.phone ?? "").trim();
  let sms = false;
  if (phone && (category === "account" || pref.sms)) {
    sms = !(await isPhoneOptedOut(db, phone));
    if (sms && category !== "account") {
      const { losAngelesHour } = await import("@/lib/reminders/rules");
      const quiet = isVendorQuietHour(settings.quietHours, losAngelesHour(options?.now ?? new Date()));
      if (quiet && !(options?.urgent && settings.emergencyBypassQuietHours)) sms = false;
    }
  }
  return { inbox: true, email, sms };
}
