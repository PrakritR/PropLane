import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAdminAuditReason } from "@/lib/admin-billing-audit.server";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { isMissingSchemaError, loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { otpMessageBody, requestPhoneOtp, verifyPhoneOtp } from "@/lib/one-number/phone-otp.server";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { updateAuditResult, writeAuditLog } from "@/lib/tools/audit";
import { SERVICE_MANAGER_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";

/**
 * The SERVICE MANAGER: the person who runs every PropLane Service (`is_service`) workspace, identified by ONE phone
 * the admin verified with a six-digit code (`platform_service_settings.manager_phone_e164` + `manager_phone_verified_at`).
 *
 * That setting is authoritative. `profiles.phone` is never consulted for this identity: on production several test
 * profiles hold the same number, and the generic "verified profile phone" lookups treat a shared number as nobody.
 *
 * What the verified phone is used for:
 *   - manager alerts for every service workspace (a new tour, application, stay request, filed service, vendor reply
 *     that needs a decision, escalation, payment) are texted to it from the PropLane line (`sendToServiceManager`);
 *   - a text FROM it to the PropLane line is the service manager: the full manager agent over every service workspace
 *     (`src/lib/sms/service-manager-inbound.server.ts`).
 *
 * Changing it is admin-only, needs the code sent to the NEW number, and is audited before it is applied.
 */

export const SERVICE_MANAGER_PHONE_AUDIT_ACTION = "admin_service_manager_phone_change";
export { SERVICE_MANAGER_SMS_PURPOSE };

export type ServiceManagerSettings = {
  ownerUserId: string;
  phoneE164: string | null;
  verifiedAt: string | null;
};

/** The singleton settings row, or null (no row, migration absent, unreadable). Columns from the newer migration read as null when absent. */
export async function readServiceManagerSettings(db: SupabaseClient): Promise<ServiceManagerSettings | null> {
  const full = await db
    .from("platform_service_settings")
    .select("owner_user_id, manager_phone_e164, manager_phone_verified_at")
    .eq("singleton", true)
    .maybeSingle();
  if (full.error) {
    if (!isMissingSchemaError(full.error)) return null;
    const ownerId = await readPlatformServiceOwnerId(db).catch(() => null);
    return ownerId ? { ownerUserId: ownerId, phoneE164: null, verifiedAt: null } : null;
  }
  const row = full.data as Record<string, unknown> | null;
  const ownerUserId = String(row?.owner_user_id ?? "").trim();
  if (!ownerUserId) return null;
  const phone = normalizeE164(String(row?.manager_phone_e164 ?? ""));
  const verifiedAt = typeof row?.manager_phone_verified_at === "string" ? row.manager_phone_verified_at : null;
  return { ownerUserId, phoneE164: phone, verifiedAt: phone && verifiedAt ? verifiedAt : null };
}

/** Is `fromPhone` the verified service manager phone? Returns the settings (and so the service owner's user id) or null. */
export async function identifyServiceManagerPhone(
  db: SupabaseClient,
  fromPhone: string | null | undefined,
): Promise<ServiceManagerSettings | null> {
  const from = normalizeConsentPhone(String(fromPhone ?? ""));
  if (from.length !== 10) return null;
  const settings = await readServiceManagerSettings(db).catch(() => null);
  if (!settings?.phoneE164 || !settings.verifiedAt) return null;
  return normalizeConsentPhone(settings.phoneE164) === from ? settings : null;
}

export type ServiceManagerView = {
  configured: boolean;
  phone: string | null;
  verified: boolean;
  verifiedAt: string | null;
};

export async function readServiceManagerView(db: SupabaseClient): Promise<ServiceManagerView> {
  const settings = await readServiceManagerSettings(db).catch(() => null);
  if (!settings) return { configured: false, phone: null, verified: false, verifiedAt: null };
  return { configured: true, phone: settings.phoneE164, verified: Boolean(settings.phoneE164 && settings.verifiedAt), verifiedAt: settings.verifiedAt };
}

export type ServiceManagerResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

function cleanPhone(raw: unknown): string | null {
  const e164 = normalizeE164(typeof raw === "string" ? raw.trim() : "");
  return e164 && /^\+1[2-9][0-9]{9}$/.test(e164) ? e164 : null;
}

const mask = (phone: string | null) => (phone ? `***${phone.slice(-4)}` : null);

/** Text the six-digit code to the number being verified, from the PropLane line (the service owner's workspace). */
export async function requestServiceManagerPhoneCode(
  db: SupabaseClient,
  adminUserId: string,
  rawPhone: unknown,
): Promise<ServiceManagerResult> {
  const phone = cleanPhone(rawPhone);
  if (!phone) return { ok: false, status: 400, error: "Enter a US phone number, like (510) 555-0100." };
  const settings = await readServiceManagerSettings(db);
  if (!settings) return { ok: false, status: 409, error: "The service owner is not set up." };
  const workspaceId = await userDefaultWorkspaceId(db, settings.ownerUserId);
  if (!workspaceId) return { ok: false, status: 409, error: "The service owner has no workspace to text from." };

  const result = await requestPhoneOtp(db, {
    phoneKey: normalizeConsentPhone(phone),
    purpose: "service_manager",
    subjectId: adminUserId,
    send: (code, challengeId) =>
      sendWorkspacePhoneText(db, {
        workspaceId,
        phoneKey: phone,
        body: otpMessageBody(code, "PropLane"),
        role: "manager",
        idempotencyKey: `service-manager-code:${challengeId}`,
        basis: { kind: "code" },
      }),
  });
  if (result.ok) return { ok: true };
  if (result.reason === "rate_limited") return { ok: false, status: 429, error: "Too many codes. Try again in a while." };
  if (result.reason === "send_failed") return { ok: false, status: 502, error: "Could not text that number." };
  return { ok: false, status: 503, error: "Could not send a code. Please retry." };
}

/**
 * Check the code and save the phone as verified. Audited FIRST (no audit row, no change), the way every other
 * admin Service change is. A wrong or expired code changes nothing.
 */
export async function verifyServiceManagerPhone(
  db: SupabaseClient,
  adminUserId: string,
  input: { phone: unknown; code: unknown; reason?: unknown },
): Promise<ServiceManagerResult<{ view: ServiceManagerView }>> {
  const phone = cleanPhone(input.phone);
  if (!phone) return { ok: false, status: 400, error: "Enter a US phone number, like (510) 555-0100." };
  const settings = await readServiceManagerSettings(db);
  if (!settings) return { ok: false, status: 409, error: "The service owner is not set up." };

  const verified = await verifyPhoneOtp(db, {
    phoneKey: normalizeConsentPhone(phone),
    purpose: "service_manager",
    subjectId: adminUserId,
    code: input.code,
  });
  if (!verified.ok) {
    const error =
      verified.reason === "locked" ? "Too many wrong codes. Try again later."
      : verified.reason === "expired" ? "That code expired. Send a new one."
      : verified.reason === "no_challenge" ? "Send a code first."
      : "That code is not right.";
    return { ok: false, status: 400, error };
  }

  const reason = normalizeAdminAuditReason(input.reason) ?? "Service manager phone verified by code";
  const dedupeKey = `service-manager-phone:${adminUserId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const actor = { db, landlordId: adminUserId, userId: adminUserId };
  const audit = await writeAuditLog(actor, {
    action: SERVICE_MANAGER_PHONE_AUDIT_ACTION,
    toolName: SERVICE_MANAGER_PHONE_AUDIT_ACTION,
    inputSummary: { before: mask(settings.phoneE164), after: mask(phone), reason },
    resultSummary: { applied: false },
    dedupeKey,
  });
  if (!audit.recorded) return { ok: false, status: 503, error: "Could not record the change. Nothing was changed." };

  const nowIso = new Date().toISOString();
  const written = await db
    .from("platform_service_settings")
    .update({ manager_phone_e164: phone, manager_phone_verified_at: nowIso, updated_at: nowIso })
    .eq("singleton", true)
    .select("singleton");
  if (written.error || !((written.data ?? []) as unknown[]).length) {
    await updateAuditResult(actor, dedupeKey, { applied: false, failed: true });
    return { ok: false, status: 503, error: "Could not save the phone. Please retry." };
  }
  await updateAuditResult(actor, dedupeKey, { applied: true });
  return { ok: true, view: { configured: true, phone, verified: true, verifiedAt: nowIso } };
}

/** Clear the phone (and its verification) together. Audited first. */
export async function clearServiceManagerPhone(db: SupabaseClient, adminUserId: string): Promise<ServiceManagerResult<{ view: ServiceManagerView }>> {
  const settings = await readServiceManagerSettings(db);
  if (!settings) return { ok: false, status: 409, error: "The service owner is not set up." };
  if (!settings.phoneE164) return { ok: false, status: 409, error: "Nothing changed." };
  const dedupeKey = `service-manager-phone:${adminUserId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const actor = { db, landlordId: adminUserId, userId: adminUserId };
  const audit = await writeAuditLog(actor, {
    action: SERVICE_MANAGER_PHONE_AUDIT_ACTION,
    toolName: SERVICE_MANAGER_PHONE_AUDIT_ACTION,
    inputSummary: { before: mask(settings.phoneE164), after: null, reason: "Service manager phone removed" },
    resultSummary: { applied: false },
    dedupeKey,
  });
  if (!audit.recorded) return { ok: false, status: 503, error: "Could not record the change. Nothing was changed." };
  const written = await db
    .from("platform_service_settings")
    .update({ manager_phone_verified_at: null, manager_phone_e164: null, updated_at: new Date().toISOString() })
    .eq("singleton", true)
    .select("singleton");
  if (written.error || !((written.data ?? []) as unknown[]).length) {
    await updateAuditResult(actor, dedupeKey, { applied: false, failed: true });
    return { ok: false, status: 503, error: "Could not remove the phone. Please retry." };
  }
  await updateAuditResult(actor, dedupeKey, { applied: true });
  return { ok: true, view: { configured: true, phone: null, verified: false, verifiedAt: null } };
}

export type ServiceManagerSendResult = { ok: true } | { ok: false; reason: string };

/**
 * Text the verified service manager phone from the PropLane line (the service owner's number in per_workspace mode,
 * the shared number in shared mode). A quiet no when no verified phone is set, or the number has texted STOP.
 * Callers pass a stable `dedupeKey`: the transport dedupes on it, so one event is one text however many notice
 * recipients it fanned out to.
 */
export async function sendToServiceManager(
  db: SupabaseClient,
  input: { text: string; dedupeKey: string; settings?: ServiceManagerSettings | null },
): Promise<ServiceManagerSendResult> {
  const text = String(input.text ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  const settings = input.settings ?? (await readServiceManagerSettings(db).catch(() => null));
  if (!settings?.phoneE164 || !settings.verifiedAt) return { ok: false, reason: "no_manager_phone" };
  const workspaceId = await userDefaultWorkspaceId(db, settings.ownerUserId);

  try {
    if (workspaceId) {
      const config = await loadSharedLineConfig(db);
      if (workspaceOnSharedLine(config, workspaceId)) {
        const sent = await sendSharedLineMessage(db, {
          workspaceId,
          ownerUserId: settings.ownerUserId,
          toPhone: settings.phoneE164,
          body: text,
          role: "manager",
          idempotencyKey: input.dedupeKey,
        });
        if (sent.ok) return { ok: true };
        if (sent.reason !== "not_shared_mode") return { ok: false, reason: sent.reason };
      }
    }
    const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
    const sent = await sendFromManagerWorkNumber({
      managerUserId: settings.ownerUserId,
      workspaceId: workspaceId || null,
      to: settings.phoneE164,
      text,
      source: "automated",
      sendClass: "transactional",
      counterpartyRole: "manager",
      purpose: SERVICE_MANAGER_SMS_PURPOSE,
      dedupeKey: input.dedupeKey.slice(0, 160),
      // The alert is not a conversation of the service owner's own; the Assistant notices carry the record.
      skipLog: true,
    });
    return sent.ok || sent.durablyAccepted ? { ok: true } : { ok: false, reason: sent.error ?? "send_failed" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "send_failed" };
  }
}
