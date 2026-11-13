import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeConsentPhone,
  readScopedSmsConsentState,
  recordScopedSmsConsent,
  type ScopedSmsConsent,
} from "@/lib/sms-consent";

export const TEAM_NOTICE_SMS_PURPOSE = "team_notice";
/** A line one member typed in the workspace Team chat, relayed to the others. */
export const TEAM_CHAT_RELAY_SMS_PURPOSE = "team_chat_relay";
/** A resident / prospect text to the work number, forwarded to a teammate with that house. */
export const TEAM_INBOUND_FORWARD_SMS_PURPOSE = "team_inbound_forward";
/** A manager alert texted to the verified SERVICE MANAGER phone (`platform_service_settings`, admin Service settings). */
export const SERVICE_MANAGER_SMS_PURPOSE = "service_manager_notice";
/**
 * A notice texted to a number the workspace owner LISTED as an "Also notify" phone (`workspace_work_number_recipients`),
 * from the owner's own work number. Before this was a manager-recipient purpose its consent read as a rental application
 * nobody filed (`scoped_consent_missing`), which the enqueue refuses without writing a row: every alert-phone text of
 * every workspace was dropped silently (prod: zero `sms_outbox` rows, ever).
 */
export const ALERT_PHONE_SMS_PURPOSE = "work_number_extra_recipient_notice";
/**
 * The same notice for a PropLane-MANAGED (`is_service`) workspace, sent from the PropLane service owner's line and wallet
 * (PropLane's own operations are never blocked by the client's wallet), to a listed alert phone or a staff seat holder.
 */
export const SERVICE_ALERT_PHONE_SMS_PURPOSE = "service_alert_phone_notice";
/** Prefix of every PropLane Assistant notice text (`manager_agent_notification_<category>`). */
export const MANAGER_NOTICE_SMS_PURPOSE_PREFIX = "manager_agent_notification_";

/**
 * Purposes whose recipient is a MANAGER on the workspace (the owner or a
 * teammate) texted at their own verified phone. Their consent is that
 * verification (`ensureTeamNoticeScopedSmsConsent`), never a rental
 * application they never filed, so the dispatcher routes all of them there.
 */
export function isManagerRecipientSmsPurpose(purpose: string | null | undefined): boolean {
  const value = String(purpose ?? "");
  return (
    value === TEAM_NOTICE_SMS_PURPOSE ||
    value === TEAM_CHAT_RELAY_SMS_PURPOSE ||
    value === TEAM_INBOUND_FORWARD_SMS_PURPOSE ||
    value === SERVICE_MANAGER_SMS_PURPOSE ||
    value === ALERT_PHONE_SMS_PURPOSE ||
    value === SERVICE_ALERT_PHONE_SMS_PURPOSE ||
    value.startsWith(MANAGER_NOTICE_SMS_PURPOSE_PREFIX)
  );
}

/**
 * Scoped consent for a `team_notice` text (WS6): the recipient is a MANAGER
 * on the workspace, never an applicant, so the evidence is their own
 * workspace opt-in — the verified work phone on their profile
 * (`profiles.phone` + `phone_verified_at`, the same pair
 * `resolveManagerNotificationChannels` treats as "personal phone ready"),
 * not a rental application they never filed. Materialized once per scope
 * the same way the application grant is; a later STOP/revoke is never
 * overwritten, and a phone that is missing, unverified, or different from
 * the one on file grants nothing.
 */
export async function ensureTeamNoticeScopedSmsConsent(
  db: SupabaseClient,
  input: ScopedSmsConsent & {
    recipientPhone: string;
    recipientUserId?: string | null;
  },
): Promise<{ ok: true; granted: boolean } | { ok: false; error: string }> {
  const messagingServiceSid = input.messagingServiceSid?.trim();
  if (!messagingServiceSid) return { ok: false, error: "provider_identity_mismatch" };
  const scope = { ...input, messagingServiceSid };
  const current = await readScopedSmsConsentState(db, input.recipientPhone, scope);
  if (!current.ok) return current;
  if (current.state === "granted") return { ok: true, granted: true };
  if (current.state === "revoked") return { ok: true, granted: false };

  // The service manager's phone is verified by a code the admin typed (platform_service_settings), not by a profile:
  // several profiles can hold the same number, so the setting alone is the evidence.
  if (input.purpose === SERVICE_MANAGER_SMS_PURPOSE) {
    const { data: settings, error: settingsError } = await db
      .from("platform_service_settings")
      .select("owner_user_id, manager_phone_e164, manager_phone_verified_at")
      .eq("singleton", true)
      .maybeSingle();
    if (settingsError) return { ok: false, error: "team_consent_unreadable" };
    const row = settings as { owner_user_id?: unknown; manager_phone_e164?: unknown; manager_phone_verified_at?: unknown } | null;
    const verifiedAt = typeof row?.manager_phone_verified_at === "string" ? row.manager_phone_verified_at.trim() : "";
    if (
      !verifiedAt ||
      Number.isNaN(Date.parse(verifiedAt)) ||
      String(row?.owner_user_id ?? "") !== input.managerUserId ||
      normalizeConsentPhone(String(row?.manager_phone_e164 ?? "")) !== normalizeConsentPhone(input.recipientPhone)
    ) {
      return { ok: true, granted: false };
    }
    const recorded = await recordScopedSmsConsent(db, input.recipientPhone, {
      ...scope,
      eventType: "granted",
      source: "service_manager_verified_phone",
      occurredAt: verifiedAt,
      evidence: { ownerUserId: input.managerUserId, phoneVerifiedAt: verifiedAt },
    });
    return recorded.ok ? { ok: true, granted: true } : recorded;
  }

  const recipientUserId = input.recipientUserId?.trim() ?? "";
  // A LISTED alert phone has no account to verify: the evidence is that the account holder listed it.
  if (!recipientUserId && (input.purpose === ALERT_PHONE_SMS_PURPOSE || input.purpose === SERVICE_ALERT_PHONE_SMS_PURPOSE)) {
    const evidence = await alertPhoneListingEvidence(db, input.purpose, input.managerUserId, input.recipientPhone);
    if (!evidence.ok) return { ok: false, error: "team_consent_unreadable" };
    if (!evidence.listed) return { ok: true, granted: false };
    const recorded = await recordScopedSmsConsent(db, input.recipientPhone, {
      ...scope,
      eventType: "granted",
      source: "owner_listed_alert_phone",
      occurredAt: evidence.listedAt,
      evidence: { listedBy: evidence.listedBy },
    });
    return recorded.ok ? { ok: true, granted: true } : recorded;
  }
  if (!recipientUserId) return { ok: true, granted: false };
  const { data, error } = await db
    .from("profiles")
    .select("phone, phone_verified_at, sms_forward_inbound")
    .eq("id", recipientUserId)
    .maybeSingle();
  if (error) return { ok: false, error: "team_consent_unreadable" };
  const profile = data as { phone?: unknown; phone_verified_at?: unknown; sms_forward_inbound?: unknown } | null;
  const verifiedAt = typeof profile?.phone_verified_at === "string" ? profile.phone_verified_at.trim() : "";
  if (
    !verifiedAt ||
    Number.isNaN(Date.parse(verifiedAt)) ||
    profile?.sms_forward_inbound === false ||
    normalizeConsentPhone(String(profile?.phone ?? "")) !== normalizeConsentPhone(input.recipientPhone)
  ) {
    return { ok: true, granted: false };
  }

  const recorded = await recordScopedSmsConsent(db, input.recipientPhone, {
    ...scope,
    eventType: "granted",
    source: "manager_verified_work_phone",
    occurredAt: verifiedAt,
    evidence: { userId: recipientUserId, phoneVerifiedAt: verifiedAt },
  });
  return recorded.ok ? { ok: true, granted: true } : recorded;
}


/**
 * Was this number listed as an "Also notify" phone by someone entitled to list it? For the owner's own purpose: by that
 * owner. For the service purpose the sender is the PropLane service owner, so the listing is read on the workspaces
 * PropLane manages: a phone listed by the owner of an `is_service` workspace (the admin attached it there). Never a
 * number nobody listed; an unreadable table is "cannot tell" (a retryable error), not "yes".
 */
async function alertPhoneListingEvidence(
  db: SupabaseClient,
  purpose: string,
  managerUserId: string,
  phone: string,
): Promise<{ ok: false } | { ok: true; listed: false } | { ok: true; listed: true; listedAt: string; listedBy: string }> {
  const key = normalizeConsentPhone(phone);
  if (!key) return { ok: true, listed: false };
  let owners: string[] = [managerUserId];
  if (purpose === SERVICE_ALERT_PHONE_SMS_PURPOSE) {
    const { data, error } = await db.from("portal_workspaces").select("owner_user_id").eq("is_service", true).limit(500);
    if (error) return { ok: false };
    owners = [...new Set(((data ?? []) as Array<{ owner_user_id?: unknown }>).map((r) => String(r.owner_user_id ?? "").trim()).filter(Boolean))];
  }
  if (owners.length === 0) return { ok: true, listed: false };
  const { data, error } = await db
    .from("workspace_work_number_recipients")
    .select("owner_user_id, phone, created_at")
    .in("owner_user_id", owners)
    .not("phone", "is", null)
    .limit(1000);
  if (error) return { ok: false };
  for (const row of (data ?? []) as Array<{ owner_user_id?: unknown; phone?: unknown; created_at?: unknown }>) {
    if (normalizeConsentPhone(String(row.phone ?? "")) === key) {
      const at = typeof row.created_at === "string" && !Number.isNaN(Date.parse(row.created_at)) ? row.created_at : new Date().toISOString();
      return { ok: true, listed: true, listedAt: at, listedBy: String(row.owner_user_id ?? "") };
    }
  }
  return { ok: true, listed: false };
}
