import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeConsentPhone,
  readScopedSmsConsentState,
  recordScopedSmsConsent,
  type ScopedSmsConsent,
} from "@/lib/sms-consent";

export const TEAM_NOTICE_SMS_PURPOSE = "team_notice";

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

  const recipientUserId = input.recipientUserId?.trim() ?? "";
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
