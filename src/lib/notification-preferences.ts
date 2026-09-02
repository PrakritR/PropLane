import type { SupabaseClient } from "@supabase/supabase-js";
import { isPhoneOptedOut } from "@/lib/sms-consent";

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
  | "account";

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  "messages",
  "leases",
  "payments",
  "maintenance",
  "applications",
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

  const phone = String(profile?.phone ?? "").trim();
  let sms = false;
  if (phone) {
    sms = !(await isPhoneOptedOut(db, phone));
  }

  return {
    inbox: true,
    email: true,
    sms,
  };
}
