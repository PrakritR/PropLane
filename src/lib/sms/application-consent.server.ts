import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  normalizeConsentPhone,
  readScopedSmsConsentState,
  recordScopedSmsConsent,
  type ScopedSmsConsent,
} from "@/lib/sms-consent";

/**
 * Materialize a purpose-specific consent grant from the server-owned rental
 * application stamp. Historical evidence can seed a scope only when that scope
 * has no events; it can never overwrite a later STOP/revoke.
 */
export async function ensureApplicationScopedSmsConsent(
  db: SupabaseClient,
  input: ScopedSmsConsent & {
    recipientPhone: string;
    recipientEmail?: string | null;
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

  let email = input.recipientEmail?.trim().toLowerCase() ?? "";
  if (!email && input.recipientUserId) {
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("email")
      .eq("id", input.recipientUserId)
      .maybeSingle();
    if (profileError) return { ok: false, error: "application_consent_unreadable" };
    email = String(profile?.email ?? "").trim().toLowerCase();
  }
  if (!email) return { ok: true, granted: false };

  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data, updated_at")
    .eq("manager_user_id", input.managerUserId)
    .eq("resident_email", email)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: "application_consent_unreadable" };

  const phoneKey = normalizeConsentPhone(input.recipientPhone);
  const evidence = (data ?? []).reduce<{
    applicationId: string;
    consentAt: string;
    wordingVersion: string | null;
  } | null>((found, record) => {
    if (found) return found;
    const application = (record.row_data as DemoApplicantRow | null)?.application;
    const consentAt = application?.smsConsentAt?.trim() ?? "";
    if (
      application?.smsConsent !== true ||
      !consentAt ||
      Number.isNaN(Date.parse(consentAt)) ||
      normalizeConsentPhone(application.phone) !== phoneKey
    ) {
      return null;
    }
    return {
      applicationId: String(record.id),
      consentAt,
      wordingVersion: application.smsConsentWordingVersion?.trim() || null,
    };
  }, null);
  if (!evidence) return { ok: true, granted: false };

  const recorded = await recordScopedSmsConsent(db, input.recipientPhone, {
    ...scope,
    eventType: "granted",
    source: "rental_application",
    wordingVersion: evidence.wordingVersion,
    occurredAt: evidence.consentAt,
    evidence: { applicationId: evidence.applicationId },
  });
  return recorded.ok ? { ok: true, granted: true } : recorded;
}

type ApplicationConsentEventRow = {
  messaging_service_sid?: string | null;
  campaign_sid?: string | null;
  purpose?: string | null;
  send_class?: string | null;
  conversation_key?: string | null;
  event_type?: string | null;
  source?: string | null;
  wording_version?: string | null;
  evidence?: Record<string, unknown> | null;
};

function applicationConsentScopeKey(row: ApplicationConsentEventRow): string {
  return [
    row.messaging_service_sid ?? "",
    row.purpose ?? "",
    row.send_class ?? "",
    row.conversation_key ?? "",
  ].join("|");
}

/**
 * Append revocations when an applicant explicitly changes a previously stored
 * SMS consent from true to false. Only a CURRENT grant materialized from this
 * exact application is revoked. A newer grant from another application or
 * consent source remains authoritative even when it occupies the same scope.
 */
export async function revokeApplicationScopedSmsConsentOnWithdrawal(
  db: SupabaseClient,
  input: {
    applicationId: string;
    managerUserId: string;
    previousRow: DemoApplicantRow | null;
    nextRow: DemoApplicantRow;
  },
): Promise<{ ok: true; revokedScopes: number } | { ok: false; error: string }> {
  const previousApplication = input.previousRow?.application;
  if (previousApplication?.smsConsent !== true || input.nextRow.application?.smsConsent !== false) {
    return { ok: true, revokedScopes: 0 };
  }

  const applicationId = input.applicationId.trim();
  const managerUserId = input.managerUserId.trim();
  const recipientPhoneKey = normalizeConsentPhone(previousApplication.phone);
  if (!applicationId || !managerUserId || !recipientPhoneKey) {
    // No valid scoped grant could have been materialized under an incomplete
    // application identity, so there is nothing in the ledger to withdraw.
    return { ok: true, revokedScopes: 0 };
  }

  // Draft writes are conditionally discarded when a submitted row wins a race.
  // Verify the false value actually landed before changing the consent ledger.
  const { data: persistedRecord, error: persistedError } = await db
    .from("manager_application_records")
    .select("row_data")
    .eq("id", applicationId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (persistedError) return { ok: false, error: "application_consent_unreadable" };
  const persistedApplication = (persistedRecord?.row_data as DemoApplicantRow | null)?.application;
  if (persistedApplication?.smsConsent !== false) return { ok: true, revokedScopes: 0 };

  const { data, error } = await db
    .from("sms_consent_events")
    .select(
      "messaging_service_sid, campaign_sid, purpose, send_class, conversation_key, event_type, source, wording_version, evidence, occurred_at, created_at",
    )
    .eq("recipient_phone_key", recipientPhoneKey)
    .eq("manager_user_id", managerUserId)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) return { ok: false, error: "application_consent_unreadable" };

  const latestByScope = new Map<string, ApplicationConsentEventRow>();
  for (const row of (data ?? []) as ApplicationConsentEventRow[]) {
    const key = applicationConsentScopeKey(row);
    if (!latestByScope.has(key)) latestByScope.set(key, row);
  }

  const revocations: Record<string, unknown>[] = [];
  for (const current of latestByScope.values()) {
    const evidenceApplicationId = String(current.evidence?.applicationId ?? "").trim();
    const messagingServiceSid = current.messaging_service_sid?.trim() ?? "";
    const purpose = current.purpose?.trim() ?? "";
    if (
      current.event_type !== "granted" ||
      current.source !== "rental_application" ||
      evidenceApplicationId !== applicationId ||
      !messagingServiceSid ||
      !purpose ||
      (current.send_class !== "transactional" && current.send_class !== "automated")
    ) {
      continue;
    }
    revocations.push({
      recipient_phone_key: recipientPhoneKey,
      manager_user_id: managerUserId,
      messaging_service_sid: messagingServiceSid,
      campaign_sid: current.campaign_sid ?? null,
      purpose,
      send_class: current.send_class,
      conversation_key: current.conversation_key ?? null,
      event_type: "revoked",
      source: "rental_application_withdrawal",
      wording_version: current.wording_version ?? null,
      evidence: { applicationId },
    });
  }

  if (revocations.length === 0) return { ok: true, revokedScopes: 0 };
  const { error: insertError } = await db.from("sms_consent_events").insert(revocations);
  return insertError
    ? { ok: false, error: "scoped_consent_write_failed" }
    : { ok: true, revokedScopes: revocations.length };
}
