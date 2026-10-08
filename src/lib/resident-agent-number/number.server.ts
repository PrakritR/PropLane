import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { isProvisioningEnabled } from "@/lib/sms/number-registration-policy";
import { isNumberSubscriptionEnabled } from "@/lib/number-subscription/constants";
import { numberServiceEntitled } from "@/lib/number-subscription/subscription.server";
import {
  createVendorWorkIdentityProvider,
  loadVendorVerifiedPhone,
  type VendorWorkIdentityProvider,
} from "@/lib/vendor-work-identity.server";
import { isVendorNumberDryRun } from "@/lib/vendor-work-number-dry-run.server";
import { areaCodeOfPhone } from "@/lib/vendor-work-number-signup.server";

/**
 * A subscribed resident's personal PropLane number (docs/ai-assistant.md § Resident personal
 * agent). A thin parallel of the vendor work-identity stack: the SAME provider adapter, runtime kill
 * switch and release worker, but its own table (`resident_agent_numbers`, phone only) so no vendor
 * code or table is touched. The insert of the row IS the purchase claim: a second attempt cannot buy.
 */

export type ResidentAgentNumber = {
  id: string;
  residentUserId: string;
  phoneNumber: string;
  sendReady: boolean;
};

export type ResidentAgentNumberStatus = {
  state: "none" | "provisioning" | "reconciling" | "ready" | "blocked" | "disabled" | "released";
  phoneNumber: string | null;
  sendReady: boolean;
};

export type ProvisionResidentAgentNumberResult =
  | { status: "ready" | "already"; phoneNumber: string }
  | { status: "pending" }
  | {
      status: "skipped";
      reason:
        | "not_entitled"
        | "phone_unverified"
        | "provider_disabled"
        | "provider_unconfigured"
        | "no_candidate"
        | "not_available";
    }
  | { status: "failed" };

const ACTIVE_SELECT = "id,resident_user_id,phone_number,state,sms_receive_ready,sms_send_ready,attachment_state";
/** A purchase with no provider resource this long after it started is definitively absent. */
const DEFINITIVE_PROVIDER_ABSENCE_MS = 15 * 60_000;

type Row = Record<string, unknown>;

function activeFrom(row: Row | null): ResidentAgentNumber | null {
  if (!row) return null;
  const phoneNumber = normalizeE164(String(row.phone_number ?? ""));
  if (!phoneNumber || row.state !== "ready" || row.sms_receive_ready !== true || row.attachment_state !== "attached") return null;
  return { id: String(row.id), residentUserId: String(row.resident_user_id), phoneNumber, sendReady: row.sms_send_ready === true };
}

/** The resident's active number (ready, attached, receiving), or null. */
export async function getActiveResidentAgentNumber(db: SupabaseClient, residentUserId: string): Promise<ResidentAgentNumber | null> {
  const { data, error } = await db.from("resident_agent_numbers").select(ACTIVE_SELECT).eq("resident_user_id", residentUserId).maybeSingle();
  if (error) throw new Error("Resident number lookup unavailable.");
  return activeFrom(data as Row | null);
}

/** Which resident owns this dialed number? Used by the inbound webhook. Null when it is nobody's. */
export async function findActiveResidentAgentNumberByPhone(db: SupabaseClient, toPhone: string): Promise<ResidentAgentNumber | null> {
  const to = normalizeE164(toPhone);
  if (!to) return null;
  const { data, error } = await db.from("resident_agent_numbers").select(ACTIVE_SELECT).eq("phone_number", to).maybeSingle();
  if (error) throw new Error("Resident number lookup unavailable.");
  return activeFrom(data as Row | null);
}

export async function getResidentAgentNumberStatus(db: SupabaseClient, residentUserId: string): Promise<ResidentAgentNumberStatus> {
  const { data, error } = await db
    .from("resident_agent_numbers")
    .select("state,phone_number,sms_send_ready")
    .eq("resident_user_id", residentUserId)
    .maybeSingle();
  if (error) throw new Error("Resident number lookup unavailable.");
  if (!data) return { state: "none", phoneNumber: null, sendReady: false };
  const row = data as Row;
  return {
    state: row.state as ResidentAgentNumberStatus["state"],
    phoneNumber: normalizeE164(String(row.phone_number ?? "")) || null,
    sendReady: row.sms_send_ready === true,
  };
}

function envUrl(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && /^https:\/\//.test(value) ? value : null;
}

function isTimeout(error: unknown): boolean {
  return /timeout|timed out|abort|network|socket|econn/i.test(error instanceof Error ? error.message : String(error));
}

async function runtimeEnabled(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from("vendor_work_identity_runtime").select("enabled").eq("singleton", true).maybeSingle();
  return !error && (data as { enabled?: boolean } | null)?.enabled === true;
}

async function numberAlreadyHeld(db: SupabaseClient, phone: string): Promise<boolean> {
  const [resident, vendor] = await Promise.all([
    db.from("resident_agent_numbers").select("id").eq("phone_number", phone).maybeSingle(),
    db.from("vendor_work_identities").select("id").eq("phone_number", phone).maybeSingle(),
  ]);
  return Boolean(resident.data) || Boolean(vendor.data);
}

/**
 * Give a subscribed resident their number, picked on the SERVER near their VERIFIED phone's area
 * code (never a number from a client). Idempotent: the row insert is the claim, so a replayed
 * webhook, a double click and a Settings retry all end at the same single number. Soft-fails to
 * `failed`/`skipped` (the Settings page offers the retry); it never throws into a webhook.
 *
 * `requireFlag` is true from Settings (the feature is hidden while the flag is off). The Stripe
 * webhook passes false: money already taken must still get its number.
 */
export async function provisionResidentAgentNumber(
  db: SupabaseClient,
  residentUserId: string,
  deps: { provider?: VendorWorkIdentityProvider; requireFlag?: boolean } = {},
): Promise<ProvisionResidentAgentNumberResult> {
  try {
    if (deps.requireFlag !== false && !isNumberSubscriptionEnabled()) return { status: "skipped", reason: "not_available" };
    if (!(await numberServiceEntitled(residentUserId, db))) return { status: "skipped", reason: "not_entitled" };
    const verified = await loadVendorVerifiedPhone(db, residentUserId);
    if (!verified.verified || !verified.phone) return { status: "skipped", reason: "phone_unverified" };

    const provider = deps.provider ?? createVendorWorkIdentityProvider();
    const dryRun = isVendorNumberDryRun();
    if (!(await runtimeEnabled(db))) return { status: "skipped", reason: "provider_disabled" };
    if (!provider.smsConfigured() || (!dryRun && !isProvisioningEnabled(process.env))) return { status: "skipped", reason: "provider_unconfigured" };

    const { data: existingData, error: existingError } = await db
      .from("resident_agent_numbers")
      .select("id,state,operation_id,phone_number,phone_number_sid,messaging_service_sid,created_at,updated_at")
      .eq("resident_user_id", residentUserId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    const existing = existingData as Row | null;
    if (existing) return await continueExisting(db, provider, existing);

    const webhookUrl = envUrl("VENDOR_WORK_IDENTITY_SMS_WEBHOOK_URL") ?? (dryRun ? "https://dry-run.invalid/api/twilio/inbound" : null);
    const callbackUrl = envUrl("VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL") ?? (dryRun ? "https://dry-run.invalid/api/twilio/events" : null);
    if (!webhookUrl || !callbackUrl) return { status: "skipped", reason: "provider_unconfigured" };

    const areaCode = areaCodeOfPhone(normalizeE164(verified.phone)) ?? "";
    if (!areaCode) return { status: "skipped", reason: "no_candidate" };
    const candidates = await provider.searchSmsCandidates({ areaCode, count: 5 });
    let phoneNumber: string | null = null;
    for (const candidate of candidates) {
      if (!areaCodeOfPhone(candidate.phoneNumber)) continue;
      if (!(await numberAlreadyHeld(db, candidate.phoneNumber))) {
        phoneNumber = candidate.phoneNumber;
        break;
      }
    }
    if (!phoneNumber) return { status: "skipped", reason: "no_candidate" };

    // The claim. A unique violation means another request already holds it: observe, never buy.
    const operationId = randomUUID();
    const { data: claimed, error: claimError } = await db
      .from("resident_agent_numbers")
      .insert({ resident_user_id: residentUserId, operation_id: operationId, state: "provisioning" })
      .select("id")
      .maybeSingle();
    if (claimError) {
      if (claimError.code === "23505") return { status: "pending" };
      throw new Error(claimError.message);
    }
    const rowId = String((claimed as Row | null)?.id ?? "");
    if (!rowId) return { status: "failed" };
    return await purchaseAndAttach(db, provider, { rowId, operationId, phoneNumber, webhookUrl, callbackUrl });
  } catch (error) {
    console.error("resident agent number provisioning failed", error instanceof Error ? error.message : "unknown");
    return { status: "failed" };
  }
}

async function purchaseAndAttach(
  db: SupabaseClient,
  provider: VendorWorkIdentityProvider,
  args: { rowId: string; operationId: string; phoneNumber: string | null; webhookUrl: string; callbackUrl: string; recoveredSid?: { phoneNumber: string; phoneSid: string } },
): Promise<ProvisionResidentAgentNumberResult> {
  const now = () => new Date().toISOString();
  try {
    // Recover an interrupted purchase by its durable friendly name before any buy.
    const prior = args.recoveredSid ?? (await provider.findSmsByOperation(args.operationId));
    const purchased =
      prior ??
      (await provider.purchaseSms({
        operationId: args.operationId,
        webhookUrl: args.webhookUrl,
        statusCallbackUrl: args.callbackUrl,
        ...(args.phoneNumber ? { phoneNumber: args.phoneNumber } : {}),
      }));
    const messagingServiceSid =
      process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || (isVendorNumberDryRun() ? "MGdryrun00000000000000000000000000" : "");
    if (!messagingServiceSid) throw new Error("Messaging Service is not configured");
    // Persist the external id BEFORE attaching, so an attach timeout is reconciled, never re-bought.
    const { error: persistError } = await db
      .from("resident_agent_numbers")
      .update({
        phone_number: purchased.phoneNumber,
        phone_number_sid: purchased.phoneSid,
        messaging_service_sid: messagingServiceSid,
        state: "reconciling",
        attachment_state: "reconciling",
        updated_at: now(),
      })
      .eq("id", args.rowId);
    if (persistError) throw new Error("purchased resident number persistence failed");
    const attachment = await provider.attachSms({ phoneSid: purchased.phoneSid, messagingServiceSid });
    const ready = attachment.attached;
    const sendReady = attachment.attached && attachment.carrierReady;
    const { error: readyError } = await db
      .from("resident_agent_numbers")
      .update({
        state: ready ? "ready" : "reconciling",
        attachment_state: ready ? "attached" : "reconciling",
        carrier_ready: attachment.carrierReady,
        sms_send_ready: sendReady,
        sms_receive_ready: ready,
        quarantine_reason: ready ? null : "sms_attachment_unready",
        updated_at: now(),
      })
      .eq("id", args.rowId);
    if (readyError) throw new Error("resident number readiness persistence failed");
    return ready ? { status: "ready", phoneNumber: purchased.phoneNumber } : { status: "pending" };
  } catch (error) {
    // Ambiguous outcome: hold in reconciling. Nothing here ever buys a second number.
    await db
      .from("resident_agent_numbers")
      .update({
        state: "reconciling",
        sms_send_ready: false,
        quarantine_reason: isTimeout(error) ? "provider_outcome_unknown" : "provider_reconciliation_required",
        updated_at: now(),
      })
      .eq("id", args.rowId);
    return { status: "pending" };
  }
}

/** A row exists: report it, repair a half-finished purchase by READING the provider, never buy again. */
async function continueExisting(db: SupabaseClient, provider: VendorWorkIdentityProvider, row: Row): Promise<ProvisionResidentAgentNumberResult> {
  const state = String(row.state);
  const phone = normalizeE164(String(row.phone_number ?? ""));
  if (state === "ready" && phone) return { status: "already", phoneNumber: phone };
  if (state === "disabled" || state === "released") return { status: "skipped", reason: "not_available" };
  const rowId = String(row.id);
  const operationId = String(row.operation_id);
  const sid = typeof row.phone_number_sid === "string" && row.phone_number_sid ? row.phone_number_sid : null;
  const messagingServiceSid = (typeof row.messaging_service_sid === "string" && row.messaging_service_sid) || process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "";
  const now = () => new Date().toISOString();

  if (sid && messagingServiceSid) {
    try {
      let sms = await provider.inspectSms({ phoneSid: sid, messagingServiceSid });
      if (!sms.attached) {
        await provider.attachSms({ phoneSid: sid, messagingServiceSid });
        sms = await provider.inspectSms({ phoneSid: sid, messagingServiceSid });
      }
      const sendReady = sms.attached && sms.carrierReady;
      await db
        .from("resident_agent_numbers")
        .update({
          state: sms.attached ? "ready" : "reconciling",
          attachment_state: sms.attached ? "attached" : "reconciling",
          phone_number: sms.phoneNumber || phone,
          carrier_ready: sms.carrierReady,
          sms_send_ready: sendReady,
          sms_receive_ready: sms.attached,
          quarantine_reason: sms.attached ? null : "provider_readiness_incomplete",
          updated_at: now(),
        })
        .eq("id", rowId);
      return sms.attached ? { status: "ready", phoneNumber: sms.phoneNumber || phone || "" } : { status: "pending" };
    } catch {
      return { status: "pending" };
    }
  }

  // No provider id was ever saved: the purchase may or may not have happened. Look it up by name.
  try {
    const found = await provider.findSmsByOperation(operationId);
    if (found) {
      const webhookUrl = envUrl("VENDOR_WORK_IDENTITY_SMS_WEBHOOK_URL") ?? "https://dry-run.invalid/api/twilio/inbound";
      const callbackUrl = envUrl("VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL") ?? "https://dry-run.invalid/api/twilio/events";
      return await purchaseAndAttach(db, provider, { rowId, operationId, phoneNumber: null, webhookUrl, callbackUrl, recoveredSid: found });
    }
    const age = Date.now() - Date.parse(String(row.created_at ?? ""));
    if (Number.isFinite(age) && age >= DEFINITIVE_PROVIDER_ABSENCE_MS) {
      // Definitively absent at the provider: free the row so the resident can try again.
      await db.from("resident_agent_numbers").delete().eq("id", rowId).is("phone_number_sid", null);
    }
  } catch {
    /* an unreadable provider is "still pending", never a reason to buy */
  }
  return { status: "pending" };
}
