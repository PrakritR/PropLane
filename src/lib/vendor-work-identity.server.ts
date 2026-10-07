import "server-only";

import { randomUUID } from "node:crypto";
import { withInboundRetryPolicy } from "@/lib/twilio-provisioning";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTwilioRestClient } from "@/lib/twilio-client.server";
import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";
import { isProvisioningEnabled } from "@/lib/sms/number-registration-policy";
import type {
  VendorWorkIdentityResponse,
  VendorWorkIdentityState,
} from "@/lib/vendor-work-identity";
import { normalizeE164, formatSmsPhoneLabel } from "@/lib/phone-e164";
import { rosterPhoneIdentifiesVendor, type ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { isUsLocalSmsNumber } from "@/lib/vendor-work-number-claim-token.server";
import { vendorNumberMonthStart } from "@/lib/vendor-work-number";
import { createDryRunVendorWorkIdentityProvider, isVendorNumberDryRun } from "@/lib/vendor-work-number-dry-run.server";

type IdentityRow = {
  id: string;
  vendor_user_id: string;
  lifecycle_state: VendorWorkIdentityState;
  email_state: VendorWorkIdentityState;
  sms_state: VendorWorkIdentityState;
  email_address: string | null;
  email_provider_id: string | null;
  email_send_ready: boolean;
  email_receive_ready: boolean;
  phone_number: string | null;
  phone_number_sid: string | null;
  messaging_service_sid: string | null;
  carrier_ready: boolean;
  sms_send_ready: boolean;
  sms_receive_ready: boolean;
  attachment_state: string;
  quarantined_at: string | null;
  released_at: string | null;
};

type RuntimeRow = {
  enabled: boolean;
  max_active_identities: number;
  outbound_message_cap: number;
};

type ClaimRow = { operation_id: string; claimed: boolean; state: string };
type ReconcileOperation = { id: string; created_at: string; state: string };
const DEFINITIVE_PROVIDER_ABSENCE_MS = 15 * 60_000;

export type VendorWorkIdentityProvider = {
  emailConfigured(): boolean;
  smsConfigured(): boolean;
  emailDomainReadiness(domain: string): Promise<{ domainId: string | null; sendReady: boolean; receiveReady: boolean }>;
  findSmsByOperation(operationId: string): Promise<{
    phoneNumber: string;
    phoneSid: string;
  } | null>;
  /** Read-only search — never purchases. Used to offer a vendor a short pick list by area code. */
  searchSmsCandidates(input: { areaCode: string; count: number }): Promise<{ phoneNumber: string }[]>;
  purchaseSms(input: {
    operationId: string;
    webhookUrl: string;
    statusCallbackUrl: string;
    /** An exact candidate the vendor picked (from `searchSmsCandidates`). Falls back to the first available number when absent. */
    phoneNumber?: string;
  }): Promise<{
    phoneNumber: string;
    phoneSid: string;
  }>;
  attachSms(input: { phoneSid: string; messagingServiceSid: string }): Promise<{
    attached: boolean;
    carrierReady: boolean;
  }>;
  inspectSms(input: { phoneSid: string; messagingServiceSid: string }): Promise<{
    phoneNumber: string;
    attached: boolean;
    carrierReady: boolean;
  }>;
};

export class ProviderAmbiguousError extends Error {
  constructor(message = "provider outcome requires reconciliation") {
    super(message);
    this.name = "ProviderAmbiguousError";
  }
}

function configuredDomain(): string | null {
  const domain = process.env.VENDOR_WORK_EMAIL_DOMAIN?.trim().toLowerCase();
  return domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : null;
}

function smsWebhookUrl(): string | null {
  const value = process.env.VENDOR_WORK_IDENTITY_SMS_WEBHOOK_URL?.trim();
  return value && /^https:\/\//.test(value) ? value : null;
}

function smsStatusCallbackUrl(): string | null {
  const value = process.env.VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL?.trim();
  return value && /^https:\/\//.test(value) ? value : null;
}

function isTimeout(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort|network|socket|econn/i.test(text);
}

/**
 * The live adapter is intentionally used only after both runtime gates pass.
 * In a dry run (`VENDOR_WORK_NUMBER_DRY_RUN=1` on a non-production box with
 * real provisioning off) the number side never reaches Twilio.
 */
export function createVendorWorkIdentityProvider(): VendorWorkIdentityProvider {
  const live = createLiveVendorWorkIdentityProvider();
  return isVendorNumberDryRun() ? createDryRunVendorWorkIdentityProvider(live) : live;
}

function createLiveVendorWorkIdentityProvider(): VendorWorkIdentityProvider {
  return {
    emailConfigured() {
      return Boolean(
        process.env.VENDOR_WORK_IDENTITY_PROVIDER_ENABLED === "1" &&
          process.env.RESEND_API_KEY?.trim() &&
          configuredDomain() &&
          process.env.VENDOR_WORK_EMAIL_DOMAIN_ID?.trim() &&
          process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim(),
      );
    },
    smsConfigured() {
      return Boolean(
        process.env.VENDOR_WORK_IDENTITY_PROVIDER_ENABLED === "1" &&
          process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() &&
          smsWebhookUrl() &&
          smsStatusCallbackUrl() &&
          createTwilioRestClient(),
      );
    },
    async emailDomainReadiness(domain) {
      const key = process.env.RESEND_API_KEY?.trim();
      if (!key) throw new Error("email provider is not configured");
      const domainId = process.env.VENDOR_WORK_EMAIL_DOMAIN_ID?.trim();
      if (!domainId) throw new Error("email domain id is not configured");
      const response = await fetch(`https://api.resend.com/domains/${encodeURIComponent(domainId)}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`email domain lookup failed (${response.status})`);
      const payload = (await response.json()) as { id?: unknown; status?: unknown; name?: unknown; capabilities?: { sending?: unknown; receiving?: unknown } };
      const verified = String(payload.status ?? "").toLowerCase() === "verified" && String(payload.name ?? "").toLowerCase() === domain;
      // Receiving is a separate, real deployment prerequisite.  Resend does
      // not expose inbound webhook readiness on this endpoint, so the signed
      // configured receiver is the persisted platform observation we require.
      return {
        domainId: typeof payload.id === "string" && payload.id === domainId ? payload.id : null,
        sendReady: verified && payload.capabilities?.sending === "enabled",
        // Resend exposes the receiver as the string capability `enabled` or
        // `disabled`; only enabled admits inbound delivery.
        receiveReady: verified && payload.capabilities?.receiving === "enabled" && Boolean(process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim()),
      };
    },
    async findSmsByOperation(operationId) {
      const client = createTwilioRestClient();
      if (!client) throw new Error("SMS provider is not configured");
      const rows = await client.incomingPhoneNumbers.list({ friendlyName: `proplane-vendor-${operationId}`, limit: 1 });
      const row = rows[0];
      return row?.sid && row.phoneNumber ? { phoneSid: row.sid, phoneNumber: row.phoneNumber } : null;
    },
    async searchSmsCandidates({ areaCode, count }) {
      const client = createTwilioRestClient();
      if (!client) throw new Error("SMS provider is not configured");
      const digits = areaCode.replace(/\D/g, "").slice(0, 3);
      if (!/^[2-9]\d{2}$/.test(digits)) return [];
      const available = await client.availablePhoneNumbers("US").local.list({
        areaCode: Number(digits),
        smsEnabled: true,
        limit: Math.max(1, Math.min(count, 10)),
      });
      return available.map((n) => ({ phoneNumber: String(n.phoneNumber) })).filter((n) => n.phoneNumber);
    },
    async purchaseSms({ operationId, webhookUrl, statusCallbackUrl, phoneNumber }) {
      const client = createTwilioRestClient();
      if (!client) throw new Error("SMS provider is not configured");
      let candidate = phoneNumber;
      if (!candidate) {
        const available = await client.availablePhoneNumbers("US").local.list({ smsEnabled: true, limit: 1 });
        candidate = available[0]?.phoneNumber;
      }
      if (!candidate) throw new Error("no SMS-capable number is available");
      // This call can succeed remotely while a response is lost.  The caller
      // transitions to reconciling on an ambiguous failure and will never buy a
      // second number until an operator/provider reconciliation resolves it.
      const number = await client.incomingPhoneNumbers.create({
        phoneNumber: candidate,
        friendlyName: `proplane-vendor-${operationId}`,
        smsUrl: withInboundRetryPolicy(webhookUrl),
        statusCallback: statusCallbackUrl,
      });
      return {
        phoneNumber: number.phoneNumber,
        phoneSid: number.sid,
      };
    },
    async attachSms({ phoneSid, messagingServiceSid }) {
      const client = createTwilioRestClient();
      if (!client) throw new Error("SMS provider is not configured");
      const attachment = await client.messaging.v1.services(messagingServiceSid).phoneNumbers.create({ phoneNumberSid: phoneSid });
      const number = await client.incomingPhoneNumbers(phoneSid).fetch();
      // A capable, attached number can receive inbound traffic, but neither
      // fact proves its 10DLC registration. Carrier readiness is set only by
      // the signed provider registration-event ledger during reconciliation.
      return { attached: Boolean(attachment.sid) && Boolean(number.capabilities?.sms), carrierReady: false };
    },
    async inspectSms({ phoneSid, messagingServiceSid }) {
      const client = createTwilioRestClient();
      if (!client) throw new Error("SMS provider is not configured");
      const [number, attachment] = await Promise.all([
        client.incomingPhoneNumbers(phoneSid).fetch(),
        client.messaging.v1.services(messagingServiceSid).phoneNumbers(phoneSid).fetch(),
      ]);
      return {
        phoneNumber: number.phoneNumber,
        attached: Boolean(attachment.sid),
        carrierReady: false,
      };
    },
  };
}

function generatedEmail(vendorUserId: string, domain: string): string {
  // UUIDs are already globally unique and safe in an email local part.  Do not
  // derive this from a business name or an arbitrary client-supplied From.
  return `vendor-${vendorUserId.replaceAll("-", "")}@${domain}`;
}

async function loadRuntime(db: SupabaseClient): Promise<RuntimeRow | null> {
  const { data, error } = await db
    .from("vendor_work_identity_runtime")
    .select("enabled,max_active_identities,outbound_message_cap")
    .eq("singleton", true)
    .maybeSingle();
  if (error || !data) return null;
  return data as RuntimeRow;
}

async function loadIdentity(db: SupabaseClient, vendorUserId: string): Promise<IdentityRow | null> {
  const { data, error } = await db
    .from("vendor_work_identities")
    .select("id,vendor_user_id,lifecycle_state,email_state,sms_state,email_address,email_provider_id,email_send_ready,email_receive_ready,phone_number,phone_number_sid,messaging_service_sid,carrier_ready,sms_send_ready,sms_receive_ready,attachment_state,quarantined_at,released_at")
    .eq("vendor_user_id", vendorUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as IdentityRow | null) ?? null;
}

export function responseFor(input: {
  identity: IdentityRow | null;
  runtime: RuntimeRow | null;
  emailConfigured: boolean;
  smsConfigured: boolean;
  outboundUsed: number;
  /** This Pacific calendar month's SMS segments / emails. Default to `outboundUsed` (callers that only know one total). */
  smsSegmentsUsed?: number;
  emailUsed?: number;
  /** Whether the vendor's profile phone is verified. Omitted = not gating (older callers/fixtures). */
  phoneVerified?: boolean;
  verifiedPhone?: string | null;
  forwardToPhone?: boolean;
  dryRun?: boolean;
}): VendorWorkIdentityResponse {
  const { identity, runtime } = input;
  const state = identity?.lifecycle_state ?? "not_started";
  const channelBlock = (channelState: VendorWorkIdentityState, configured: boolean): VendorWorkIdentityResponse["email"]["blockedReason"] => {
    if (!runtime?.enabled) return "provider_disabled";
    if (!configured) return "provider_unconfigured";
    if (channelState === "quarantined" || channelState === "reconciling" || channelState === "blocked") return "identity_quarantined";
    if (channelState === "released") return "identity_released";
    return "none";
  };
  const emailState = identity?.email_state ?? state;
  const smsState = identity?.sms_state ?? state;
  const emailBlocked = channelBlock(emailState, input.emailConfigured);
  let smsBlocked = channelBlock(smsState, input.smsConfigured);
  // A number is for a vendor whose phone is verified. The gate only blocks a CLAIM:
  // an already-ready number keeps working if the verification later lapses.
  if (smsBlocked === "none" && input.phoneVerified === false && smsState !== "ready") smsBlocked = "phone_unverified";
  const cap = runtime?.outbound_message_cap ?? 0;
  const smsUsed = input.smsSegmentsUsed ?? input.outboundUsed;
  const emailUsed = input.emailUsed ?? input.outboundUsed;
  const smsCapped = cap <= smsUsed;
  const emailCapped = cap <= emailUsed;
  const emailLifecycleReady = emailState === "ready";
  const smsLifecycleReady = smsState === "ready";
  const emailReceiveReady = emailLifecycleReady && input.emailConfigured && Boolean(identity?.email_receive_ready);
  const smsReceiveReady = smsLifecycleReady && input.smsConfigured && Boolean(identity?.sms_receive_ready);
  const emailSendReady = emailLifecycleReady && input.emailConfigured && Boolean(runtime?.enabled) && !emailCapped && Boolean(identity?.email_send_ready);
  const smsSendReady = smsLifecycleReady && input.smsConfigured && Boolean(runtime?.enabled) && !smsCapped && Boolean(identity?.sms_send_ready);
  return {
    sponsoredBy: "proplane",
    email: {
      state: emailState,
      value: identity?.email_address ?? null,
      sendReady: emailSendReady,
      receiveReady: emailReceiveReady,
      canSetup: emailBlocked === "none" && !["ready", "disabled", "released", "blocked", "quarantined", "reconciling"].includes(emailState),
      blockedReason: emailBlocked,
    },
    sms: {
      state: smsState,
      value: identity?.phone_number ?? null,
      sendReady: smsSendReady,
      receiveReady: smsReceiveReady,
      canSetup: smsBlocked === "none" && !["ready", "disabled", "released", "blocked", "quarantined", "reconciling"].includes(smsState),
      blockedReason: smsBlocked,
    },
    inboundAvailable: { email: emailReceiveReady, sms: smsReceiveReady },
    // UI visibility never controls the owned number's inbound routing/storage.
    smsUiEnabled: isSmsCommUiEnabled(),
    usage: {
      outboundUsed: input.outboundUsed,
      outboundCap: cap,
      capState: cap <= 0 ? "unconfigured" : smsCapped ? "exhausted" : "available",
      smsSegmentsUsed: smsUsed,
    },
    ...(input.phoneVerified === undefined
      ? {}
      : { eligibility: { phoneVerified: input.phoneVerified, verifiedPhoneLabel: input.verifiedPhone ? formatSmsPhoneLabel(input.verifiedPhone) : null } }),
    ...(input.forwardToPhone === undefined ? {} : { forwardToPhone: input.forwardToPhone }),
    ...(input.dryRun ? { dryRun: true } : {}),
  };
}

/** The vendor's verified personal phone: the claim gate and the forwarding destination. */
export async function loadVendorVerifiedPhone(db: SupabaseClient, vendorUserId: string): Promise<{ verified: boolean; phone: string | null }> {
  const { data, error } = await db.from("profiles").select("phone, phone_verified_at").eq("id", vendorUserId).maybeSingle();
  if (error || !data) return { verified: false, phone: null };
  const row = data as { phone?: unknown; phone_verified_at?: unknown };
  const phone = normalizeE164(String(row.phone ?? ""));
  return { verified: Boolean(row.phone_verified_at) && Boolean(phone), phone };
}

/**
 * The forwarding preference lives in its own column (migration 20261006200000).
 * Read it separately so a database that has not applied that migration yet still
 * answers - forwarding then defaults on, the approved default.
 */
export async function readVendorForwardToPhone(db: SupabaseClient, vendorUserId: string): Promise<boolean> {
  const { data, error } = await db.from("vendor_work_identities").select("forward_to_phone").eq("vendor_user_id", vendorUserId).maybeSingle();
  if (error || !data) return true;
  return (data as { forward_to_phone?: unknown }).forward_to_phone !== false;
}

export async function setVendorForwardToPhone(db: SupabaseClient, vendorUserId: string, forward: boolean): Promise<boolean> {
  const { data, error } = await db.from("vendor_work_identities")
    .update({ forward_to_phone: forward, updated_at: new Date().toISOString() })
    .eq("vendor_user_id", vendorUserId).select("id").maybeSingle();
  return !error && Boolean(data);
}

/** A vendor's number that can receive today: ready, attached and receiving. */
export type ActiveVendorNumber = {
  identityId: string;
  vendorUserId: string;
  phoneNumber: string;
  sendReady: boolean;
  forwardToPhone: boolean;
};

const ACTIVE_NUMBER_SELECT = "id,vendor_user_id,phone_number,sms_state,sms_receive_ready,sms_send_ready,attachment_state";

function activeFrom(row: Record<string, unknown> | null, forwardToPhone: boolean): ActiveVendorNumber | null {
  if (!row) return null;
  const phoneNumber = normalizeE164(String(row.phone_number ?? ""));
  if (!phoneNumber || row.sms_state !== "ready" || row.sms_receive_ready !== true || row.attachment_state !== "attached") return null;
  return { identityId: String(row.id), vendorUserId: String(row.vendor_user_id), phoneNumber, sendReady: row.sms_send_ready === true, forwardToPhone };
}

/** The vendor's active PropLane number, or null (never claimed, released, quarantined, not receiving). */
export async function getActiveVendorNumber(db: SupabaseClient, vendorUserId: string): Promise<ActiveVendorNumber | null> {
  const { data, error } = await db.from("vendor_work_identities").select(ACTIVE_NUMBER_SELECT).eq("vendor_user_id", vendorUserId).maybeSingle();
  if (error) throw new Error("Vendor number lookup unavailable.");
  const active = activeFrom(data as Record<string, unknown> | null, true);
  if (!active) return null;
  return { ...active, forwardToPhone: await readVendorForwardToPhone(db, vendorUserId) };
}

/**
 * A vendor texting a manager's work line from their PropLane number is the same
 * person the manager already has on their Vendors list. Map the sender back to
 * the phone that roster row (or, failing that, the vendor's verified profile)
 * carries, so the manager's whole inbound pipeline - the vendor thread, consent,
 * the 7-day rule, history - sees one vendor, not an unknown number. Null when
 * the sender is not a vendor's active number.
 */
export async function resolveVendorNumberSenderPhone(
  db: SupabaseClient,
  input: { fromPhone: string; ownerManagerUserId: string },
): Promise<string | null> {
  const from = normalizeE164(input.fromPhone);
  if (!from) return null;
  const { data: identity, error } = await db.from("vendor_work_identities")
    .select("vendor_user_id,sms_state").eq("phone_number", from).maybeSingle();
  if (error) throw new Error("Vendor number lookup unavailable.");
  const vendorUserId = String((identity as { vendor_user_id?: unknown } | null)?.vendor_user_id ?? "").trim();
  if (!vendorUserId || (identity as { sms_state?: unknown }).sms_state !== "ready") return null;
  const { data: rows } = await db.from("manager_vendor_records")
    .select("id, row_data").eq("manager_user_id", input.ownerManagerUserId).eq("vendor_user_id", vendorUserId)
    // Deterministic across calls, and an unverified service-link phone is the
    // number the MANAGER typed, not this vendor's: mapping their PropLane-number
    // texts onto it would send the thread to whoever that really is.
    .order("id", { ascending: true }).limit(5);
  for (const row of (rows ?? []) as { row_data?: ManagerVendorRow | null }[]) {
    if (row.row_data?.active === false) continue;
    if (!rosterPhoneIdentifiesVendor(row.row_data)) continue;
    const phone = normalizeE164(String(row.row_data?.phone ?? "").trim());
    if (phone) return phone;
  }
  return (await loadVendorVerifiedPhone(db, vendorUserId)).phone;
}

/** Which vendor owns this dialed number? Used by the inbound webhook before manager-number ownership. */
export async function findActiveVendorNumberByPhone(db: SupabaseClient, toPhone: string): Promise<ActiveVendorNumber | null> {
  const to = normalizeE164(toPhone);
  if (!to) return null;
  const { data, error } = await db.from("vendor_work_identities").select(ACTIVE_NUMBER_SELECT).eq("phone_number", to).maybeSingle();
  if (error) throw new Error("Vendor number lookup unavailable.");
  const active = activeFrom(data as Record<string, unknown> | null, true);
  if (!active) return null;
  return { ...active, forwardToPhone: await readVendorForwardToPhone(db, active.vendorUserId) };
}

/**
 * Read-only "which numbers could I claim in this area code" lookup — no
 * database writes, no idempotency claim, because nothing is purchased. Gated
 * the same way a real purchase would be so a disabled/unconfigured provider
 * never leaks a live Twilio search to an unauthenticated flow.
 */
export async function searchVendorWorkNumberCandidates(
  areaCode: string,
  provider: VendorWorkIdentityProvider = createVendorWorkIdentityProvider(),
): Promise<string[]> {
  if (!provider.smsConfigured()) return [];
  if (!isVendorNumberDryRun() && !isProvisioningEnabled(process.env)) return [];
  const candidates = await provider.searchSmsCandidates({ areaCode, count: 3 });
  return candidates.map((c) => c.phoneNumber);
}

export async function getVendorWorkIdentity(db: SupabaseClient, vendorUserId: string, provider: VendorWorkIdentityProvider = createVendorWorkIdentityProvider()): Promise<VendorWorkIdentityResponse> {
  const [runtime, identity, verified] = await Promise.all([loadRuntime(db), loadIdentity(db, vendorUserId), loadVendorVerifiedPhone(db, vendorUserId)]);
  let smsSegmentsUsed = 0;
  let emailUsed = 0;
  if (identity) {
    // The fair-use cap is per Pacific calendar month: only this month's events count.
    const { data, error } = await db.from("vendor_work_identity_usage_events").select("meter,quantity")
      .eq("identity_id", identity.id).in("meter", ["outbound_email", "outbound_sms"])
      .gte("created_at", vendorNumberMonthStart().toISOString());
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { meter?: unknown; quantity?: unknown }[]) {
      const quantity = Number(row.quantity ?? 0);
      if (row.meter === "outbound_sms") smsSegmentsUsed += quantity;
      else emailUsed += quantity;
    }
  }
  return responseFor({
    identity, runtime, emailConfigured: provider.emailConfigured(), smsConfigured: provider.smsConfigured(),
    outboundUsed: smsSegmentsUsed + emailUsed, smsSegmentsUsed, emailUsed,
    phoneVerified: verified.verified, verifiedPhone: verified.phone,
    forwardToPhone: identity ? await readVendorForwardToPhone(db, vendorUserId) : true,
    dryRun: isVendorNumberDryRun(),
  });
}

async function setReconcileState(db: SupabaseClient, identityId: string, operationId: string, channel: "email" | "sms", error: unknown): Promise<void> {
  const timeout = isTimeout(error) || error instanceof ProviderAmbiguousError;
  const reason = timeout ? "provider_outcome_unknown" : "provider_reconciliation_required";
  const identityPatch = channel === "email"
    ? { email_state: "reconciling", email_send_ready: false, quarantined_at: new Date().toISOString(), quarantine_reason: reason, updated_at: new Date().toISOString() }
    : { sms_state: "reconciling", attachment_state: "reconciling", sms_send_ready: false, quarantined_at: new Date().toISOString(), quarantine_reason: reason, updated_at: new Date().toISOString() };
  const { error: identityError } = await db.from("vendor_work_identities").update(identityPatch).eq("id", identityId);
  if (identityError) throw new Error(identityError.message);
  const { error: operationError } = await db.from("vendor_work_identity_operations").update({ state: "reconciling", error_code: reason, updated_at: new Date().toISOString() }).eq("id", operationId);
  if (operationError) throw new Error(operationError.message);
}

/**
 * Performs the provider-bound setup transition.  Callers must supply an
 * idempotency key; a claimed/reconciling operation is observed, never replayed.
 */
export async function setupVendorWorkIdentity(
  db: SupabaseClient,
  vendorUserId: string,
  idempotencyKey: string = randomUUID(),
  channel: "email" | "sms" = "email",
  provider: VendorWorkIdentityProvider = createVendorWorkIdentityProvider(),
  /** An exact number the vendor picked from `searchVendorWorkNumberCandidates`. SMS only. */
  selectedPhoneNumber?: string,
): Promise<VendorWorkIdentityResponse> {
  const runtime = await loadRuntime(db);
  if (!runtime?.enabled || (channel === "email" ? !provider.emailConfigured() : !provider.smsConfigured())) return getVendorWorkIdentity(db, vendorUserId, provider);
  // Sponsored numbers are still real provider purchases. The platform-wide
  // provisioning kill switch governs them just as it governs manager lines.
  if (channel === "sms" && !isVendorNumberDryRun() && !isProvisioningEnabled(process.env)) return getVendorWorkIdentity(db, vendorUserId, provider);
  // Eligibility: a verified phone, nothing else (no card, no plan). The verified
  // phone is also where forwarded texts go, so an unverified one has no purpose here.
  if (channel === "sms" && !(await loadVendorVerifiedPhone(db, vendorUserId)).verified) return getVendorWorkIdentity(db, vendorUserId, provider);
  if (channel === "sms" && selectedPhoneNumber !== undefined && !isUsLocalSmsNumber(selectedPhoneNumber)) return getVendorWorkIdentity(db, vendorUserId, provider);
  // Never a second real purchase. `claim_vendor_work_identity_operation`'s
  // idempotency guard only protects against REPLAYING the same key — a
  // fresh idempotency key with channel "sms" would otherwise sail straight
  // through it and buy another number for a vendor who already has one (or
  // has one mid-flight). Reconciling a stuck/ambiguous purchase is the one
  // job of reconcileVendorWorkIdentity, which never buys a replacement
  // either — this function only ever buys from a genuinely fresh identity.
  if (channel === "sms") {
    const current = await loadIdentity(db, vendorUserId);
    if (current && (current.phone_number || current.sms_state !== "not_started")) {
      return getVendorWorkIdentity(db, vendorUserId, provider);
    }
  }
  const domain = channel === "email" ? configuredDomain() : null;
  if (channel === "email" && !domain) return getVendorWorkIdentity(db, vendorUserId, provider);
  const { data: ensured, error: ensureError } = await db.rpc("ensure_vendor_work_identity", {
    p_vendor_user_id: vendorUserId,
    p_email_address: domain ? generatedEmail(vendorUserId, domain) : null,
  });
  if (ensureError) throw new Error(ensureError.message);
  if (typeof ensured !== "string") {
    const current = await getVendorWorkIdentity(db, vendorUserId, provider);
    const channelCurrent = channel === "email" ? current.email : current.sms;
    const next = { ...channelCurrent, canSetup: false, blockedReason: runtime.enabled ? "platform_capacity_reached" as const : "provider_disabled" as const };
    return channel === "email" ? { ...current, email: next } : { ...current, sms: next };
  }
  const { data: claimedData, error: claimError } = await db.rpc("claim_vendor_work_identity_operation", {
    p_vendor_user_id: vendorUserId, p_identity_id: ensured, p_operation_kind: channel === "email" ? "setup_email" : "setup_sms", p_idempotency_key: idempotencyKey,
  });
  if (claimError) throw new Error(claimError.message);
  const claim = Array.isArray(claimedData) ? claimedData[0] as ClaimRow | undefined : claimedData as ClaimRow | null;
  if (!claim?.claimed) return getVendorWorkIdentity(db, vendorUserId, provider);

  const { error: provisioningError } = await db.from("vendor_work_identities").update(channel === "email" ? { email_state: "provisioning", updated_at: new Date().toISOString() } : { sms_state: "provisioning", attachment_state: "provisioning", updated_at: new Date().toISOString() }).eq("id", ensured);
  if (provisioningError) throw new Error(provisioningError.message);
  const { error: operationCallingError } = await db.from("vendor_work_identity_operations").update({ state: "calling_provider", updated_at: new Date().toISOString() }).eq("id", claim.operation_id);
  if (operationCallingError) throw new Error(operationCallingError.message);
  try {
    if (channel === "email") {
      const email = await provider.emailDomainReadiness(domain!);
      if ((!email.sendReady && !email.receiveReady) || !email.domainId) {
        const { error: emailBlockedError } = await db.from("vendor_work_identities").update({ email_state: "blocked", email_provider_id: email.domainId, email_domain_verified: false, email_send_ready: email.sendReady, email_receive_ready: email.receiveReady, last_error: "email_domain_not_ready", updated_at: new Date().toISOString() }).eq("id", ensured);
        if (emailBlockedError) throw new Error(emailBlockedError.message);
        const { error: emailOperationError } = await db.from("vendor_work_identity_operations").update({ state: "failed", error_code: "email_domain_not_ready", updated_at: new Date().toISOString() }).eq("id", claim.operation_id);
        if (emailOperationError) throw new Error(emailOperationError.message);
        return getVendorWorkIdentity(db, vendorUserId, provider);
      }
      const { error: emailReadyError } = await db.from("vendor_work_identities").update({ email_state: "ready", email_provider_id: email.domainId, email_domain_verified: true, email_send_ready: email.sendReady, email_receive_ready: email.receiveReady, updated_at: new Date().toISOString() }).eq("id", ensured);
      if (emailReadyError) throw new Error(emailReadyError.message);
      const { error: emailOperationReadyError } = await db.from("vendor_work_identity_operations").update({ state: "succeeded", provider_reference: email.domainId, updated_at: new Date().toISOString() }).eq("id", claim.operation_id);
      if (emailOperationReadyError) throw new Error(emailOperationReadyError.message);
      return getVendorWorkIdentity(db, vendorUserId, provider);
    }
    const dryRun = isVendorNumberDryRun();
    const webhookUrl = smsWebhookUrl() ?? (dryRun ? "https://dry-run.invalid/api/twilio/inbound" : null);
    const callbackUrl = smsStatusCallbackUrl() ?? (dryRun ? "https://dry-run.invalid/api/twilio/events" : null);
    if (!webhookUrl || !callbackUrl) throw new Error("SMS webhook configuration is unavailable");
    // Recover an interrupted purchase by its durable friendlyName before any
    // purchase attempt.  A missing result is the only case allowed to buy.
    const prior = await provider.findSmsByOperation(claim.operation_id);
    const purchased = prior ?? await provider.purchaseSms({ operationId: claim.operation_id, webhookUrl, statusCallbackUrl: callbackUrl, phoneNumber: selectedPhoneNumber });
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || (dryRun ? "MGdryrun00000000000000000000000000" : "");
    if (!messagingServiceSid) throw new Error("Messaging Service is not configured");
    // Persist the externally allocated SID before attempting attachment.  An
    // attachment timeout can then be inspected/reconciled without another buy.
    const { error: identityPersistError } = await db.from("vendor_work_identities").update({
      phone_number: purchased.phoneNumber, phone_number_sid: purchased.phoneSid, messaging_service_sid: messagingServiceSid,
      sms_state: "reconciling", attachment_state: "reconciling", updated_at: new Date().toISOString(),
    }).eq("id", ensured);
    if (identityPersistError) throw new ProviderAmbiguousError("purchased vendor number persistence failed");
    const { error: operationPersistError } = await db.from("vendor_work_identity_operations").update({ state: "reconciling", provider_reference: purchased.phoneSid, updated_at: new Date().toISOString() }).eq("id", claim.operation_id);
    if (operationPersistError) throw new ProviderAmbiguousError("vendor provider operation persistence failed");
    const attachment = await provider.attachSms({ phoneSid: purchased.phoneSid, messagingServiceSid });
    const ready = attachment.attached;
    const sendReady = attachment.attached && attachment.carrierReady;
    const { error: readyError } = await db.from("vendor_work_identities").update({
      sms_state: ready ? "ready" : "reconciling", carrier_ready: attachment.carrierReady, sms_registration_state: sendReady ? "registered" : "pending", sms_send_ready: sendReady, sms_receive_ready: ready,
      attachment_state: attachment.attached ? "attached" : "reconciling", quarantined_at: ready ? null : new Date().toISOString(),
      quarantine_reason: ready ? null : "sms_attachment_unready", updated_at: new Date().toISOString(),
    }).eq("id", ensured);
    if (readyError) throw new ProviderAmbiguousError("vendor SMS readiness persistence failed");
    const { error: operationReadyError } = await db.from("vendor_work_identity_operations").update({ state: ready ? "succeeded" : "reconciling", error_code: ready ? null : "sms_not_ready", updated_at: new Date().toISOString() }).eq("id", claim.operation_id);
    if (operationReadyError) throw new ProviderAmbiguousError("vendor SMS operation readiness persistence failed");
  } catch (error) {
    await setReconcileState(db, ensured, claim.operation_id, channel, error);
  }
  return getVendorWorkIdentity(db, vendorUserId, provider);
}

/** Re-reads actual provider attachment/carrier state; it never purchases a replacement number. */
export async function reconcileVendorWorkIdentity(
  db: SupabaseClient,
  vendorUserId: string,
  provider: VendorWorkIdentityProvider = createVendorWorkIdentityProvider(),
): Promise<VendorWorkIdentityResponse> {
  const identity = await loadIdentity(db, vendorUserId);
  if (!identity || !provider.smsConfigured()) return getVendorWorkIdentity(db, vendorUserId, provider);
  let phoneSid = identity.phone_number_sid;
  const messagingServiceSid = identity.messaging_service_sid ?? process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? null;
  let operation: ReconcileOperation | null = null;
  if (!phoneSid) {
    const { data, error } = await db.from("vendor_work_identity_operations")
      .select("id,created_at,state")
      .eq("identity_id", identity.id).eq("operation_kind", "setup_sms")
      .in("state", ["calling_provider", "reconciling"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    operation = data as ReconcileOperation | null;
    if (!operation) return getVendorWorkIdentity(db, vendorUserId, provider);
    const found = await provider.findSmsByOperation(operation.id);
    if (!found) {
      const age = Date.now() - Date.parse(operation.created_at);
      if (Number.isFinite(age) && age >= DEFINITIVE_PROVIDER_ABSENCE_MS) {
        const { error: identityError } = await db.from("vendor_work_identities").update({ sms_state: "blocked", attachment_state: "failed", quarantine_reason: "provider_resource_absent", updated_at: new Date().toISOString() }).eq("id", identity.id);
        if (identityError) throw new Error(identityError.message);
        const { error: opError } = await db.from("vendor_work_identity_operations").update({ state: "failed", error_code: "provider_resource_absent", updated_at: new Date().toISOString() }).eq("id", operation.id);
        if (opError) throw new Error(opError.message);
      }
      return getVendorWorkIdentity(db, vendorUserId, provider);
    }
    phoneSid = found.phoneSid;
    const { error: recoverError } = await db.from("vendor_work_identities").update({
      phone_number: found.phoneNumber, phone_number_sid: found.phoneSid, messaging_service_sid: messagingServiceSid,
      sms_state: "reconciling", attachment_state: "reconciling", updated_at: new Date().toISOString(),
    }).eq("id", identity.id);
    if (recoverError) throw new Error(recoverError.message);
    const { error: operationError } = await db.from("vendor_work_identity_operations").update({ state: "reconciling", provider_reference: found.phoneSid, updated_at: new Date().toISOString() }).eq("id", operation.id);
    if (operationError) throw new Error(operationError.message);
  }
  if (!phoneSid || !messagingServiceSid) return getVendorWorkIdentity(db, vendorUserId, provider);
  try {
    let sms = await provider.inspectSms({ phoneSid, messagingServiceSid });
    // Attachment create is permitted only after a provider read says it is
    // missing.  The second read makes Ready dependent on observed state, never
    // merely a successful create response.
    if (!sms.attached) {
      await provider.attachSms({ phoneSid, messagingServiceSid });
      sms = await provider.inspectSms({ phoneSid, messagingServiceSid });
    }
    const ready = sms.attached;
    const sendReady = sms.attached && sms.carrierReady;
    const { error } = await db.from("vendor_work_identities").update({
      sms_state: ready ? "ready" : "reconciling", phone_number: sms.phoneNumber,
      carrier_ready: sms.carrierReady, sms_registration_state: sendReady ? "registered" : "pending", sms_send_ready: sendReady, sms_receive_ready: ready,
      attachment_state: sms.attached ? "attached" : "reconciling", quarantined_at: ready ? null : new Date().toISOString(),
      quarantine_reason: ready ? null : "provider_readiness_incomplete", updated_at: new Date().toISOString(),
    }).eq("id", identity.id);
    if (error) throw new Error(error.message);
    const { error: operationConvergeError } = await db.from("vendor_work_identity_operations")
      .update({ state: ready ? "succeeded" : "reconciling", provider_reference: phoneSid, error_code: ready ? null : "provider_readiness_incomplete", updated_at: new Date().toISOString() })
      .eq("identity_id", identity.id).eq("operation_kind", "setup_sms").in("state", ["calling_provider", "reconciling"]);
    if (operationConvergeError) throw new Error(operationConvergeError.message);
  } catch (error) {
    const { error: updateError } = await db.from("vendor_work_identities").update({ sms_state: "reconciling", quarantined_at: new Date().toISOString(), quarantine_reason: isTimeout(error) ? "provider_outcome_unknown" : "provider_reconciliation_failed", sms_send_ready: false, updated_at: new Date().toISOString() }).eq("id", identity.id);
    if (updateError) throw new Error(updateError.message);
  }
  return getVendorWorkIdentity(db, vendorUserId, provider);
}

/** Queue external IDs before the auth cascade; sends are disabled synchronously. */
export async function queueVendorWorkIdentityRelease(db: SupabaseClient, vendorUserId: string): Promise<void> {
  const { error } = await db.rpc("queue_vendor_work_identity_release", { p_vendor_user_id: vendorUserId });
  if (error) throw new Error(error.message);
}
