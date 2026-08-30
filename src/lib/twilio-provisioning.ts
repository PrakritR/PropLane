import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clawLeasingAgentPhoneE164,
  isClawSharedLineBridgeEnabled,
  isLegacyClawSharedSmsNumber,
  isPlaceholderManagerWorkNumber,
} from "@/lib/claw-leasing-links";
import { PRODUCTION_APP_ORIGIN, resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  createTwilioRestClient,
  twilioErrorFields,
} from "@/lib/twilio-client.server";

export type EnsureManagerSmsNumberResult =
  | { ok: true; number: string }
  | { ok: false; error: string };

/**
 * Fully-qualified URL Twilio should POST inbound SMS to. `TWILIO_WEBHOOK_URL`
 * (when set) is the exact endpoint the inbound route validates signatures
 * against, so the purchased number's smsUrl MUST match it verbatim. Otherwise
 * we build it off the canonical (never-vercel) app origin.
 */
export function resolveInboundWebhookUrl(): string {
  const explicit = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const base = (resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "");
  return `${base}/api/twilio/inbound`;
}

export type PurchaseTwilioNumberResult =
  | { ok: true; number: string; sid: string; messagingServiceSid: string | null }
  | {
      ok: false;
      error: string;
      cleanupConfirmed?: boolean;
      purchasedNumber?: { number: string; sid: string };
    };

function twilioOperationError(operation: string, error: unknown): string {
  const fields = twilioErrorFields(error);
  const identifiers = [
    fields.code ? `code ${fields.code}` : null,
    fields.status ? `HTTP ${fields.status}` : null,
  ].filter(Boolean);
  return `${operation} failed${identifiers.length ? ` (${identifiers.join(", ")})` : ""}.`;
}

/**
 * Provider-only Twilio purchase: find an SMS-capable US local number, buy it,
 * wire the inbound webhook, and best-effort attach it to the Messaging Service
 * (so it inherits the A2P campaign). Does NO database writes — the state-machine
 * caller owns persistence, the atomic slot claim, and rollback-on-race.
 */
export async function purchaseManagerTwilioNumber(opts?: {
  areaCode?: string;
  requestId?: string;
}): Promise<PurchaseTwilioNumberResult> {
  const client = createTwilioRestClient();
  if (!client) {
    return { ok: false, error: "SMS is not configured (missing Twilio credentials)." };
  }

  const areaCodeDigits = opts?.areaCode?.replace(/\D/g, "").slice(0, 3);
  const areaCode = areaCodeDigits && areaCodeDigits.length === 3 ? Number(areaCodeDigits) : undefined;
  let purchaseOutcomeMayBeAmbiguous = false;

  try {
    const available = await client.availablePhoneNumbers("US").local.list({
      ...(areaCode ? { areaCode } : {}),
      smsEnabled: true,
      limit: 1,
    });
    const candidate = String(available[0]?.phoneNumber ?? "").trim();
    if (!candidate) {
      return {
        ok: false,
        error: areaCode
          ? `No SMS-capable numbers are available in area code ${areaCodeDigits} right now.`
          : "No SMS-capable numbers are available right now — try again shortly.",
      };
    }

    // A transport failure after this request reaches Twilio can hide a
    // successful purchase. Keep the durable request id quarantined so the
    // reconciliation worker can find that exact friendlyName; opening the row
    // for an immediate retry could buy a second number.
    purchaseOutcomeMayBeAmbiguous = true;
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: candidate,
      ...(opts?.requestId ? { friendlyName: `proplane-manager-${opts.requestId}` } : {}),
      smsUrl: resolveInboundWebhookUrl(),
      smsMethod: "POST",
    });
    const number = String(purchased.phoneNumber ?? candidate).trim();
    const phoneNumberSid = String(purchased.sid ?? "").trim();

    let messagingServiceSid: string | null = null;
    const svc = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    if (!svc || !phoneNumberSid) {
      const released = phoneNumberSid
        ? await client
            .incomingPhoneNumbers(phoneNumberSid)
            .remove()
            .catch((cleanupError) => {
              console.error(
                "Twilio number cleanup after configuration failure failed",
                {
                  phoneNumberSid,
                  ...twilioErrorFields(cleanupError),
                },
              );
              return false;
            })
        : false;
      return {
        ok: false,
        cleanupConfirmed: released,
        purchasedNumber: phoneNumberSid
          ? { number, sid: phoneNumberSid }
          : undefined,
        error: released
          ? "Messaging Service attachment is not configured. The purchased number was released."
          : "Messaging Service attachment is not configured. The purchased number release could not be confirmed; do not retry until PropLane reviews it.",
      };
    }
    try {
      await client.messaging.v1.services(svc).phoneNumbers.create({ phoneNumberSid });
      messagingServiceSid = svc;
    } catch (error) {
      const diagnostic = twilioOperationError(
        "Twilio Messaging Service sender-pool attachment",
        error,
      );
      console.error("Twilio Messaging Service sender-pool attachment failed", {
        phoneNumberSid,
        messagingServiceSid: svc,
        ...twilioErrorFields(error),
      });
      const released = await client
        .incomingPhoneNumbers(phoneNumberSid)
        .remove()
        .catch((cleanupError) => {
          console.error("Twilio number cleanup after attachment failure failed", {
            phoneNumberSid,
            ...twilioErrorFields(cleanupError),
          });
          return false;
        });
      return {
        ok: false,
        cleanupConfirmed: released,
        purchasedNumber: { number, sid: phoneNumberSid },
        error: released
          ? `${diagnostic} The purchased number was released.`
          : `${diagnostic} The purchased number release could not be confirmed; do not retry until PropLane reviews it.`,
      };
    }

    return { ok: true, number, sid: phoneNumberSid, messagingServiceSid };
  } catch (e) {
    if (purchaseOutcomeMayBeAmbiguous && opts?.requestId) {
      return {
        ok: false,
        cleanupConfirmed: false,
        error: `${twilioOperationError("Twilio work-number purchase", e)} Provider ownership is unconfirmed; do not retry until PropLane reviews it.`,
      };
    }
    return {
      ok: false,
      error: twilioOperationError("Twilio work-number provisioning", e),
    };
  }
}

export type ReconciledTwilioNumber = {
  number: string;
  sid: string;
  messagingServiceSid: string;
};

/** Read-only lookup for a purchase whose HTTP response may have been lost. */
export async function findManagerTwilioNumberByRequestId(
  requestId: string,
): Promise<{ ok: true; number: ReconciledTwilioNumber | null } | { ok: false; error: string }> {
  const id = requestId.trim();
  const serviceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const client = createTwilioRestClient();
  if (!id || !serviceSid || !client) return { ok: false, error: "SMS provider reconciliation is not configured." };
  try {
    const matches = await client.incomingPhoneNumbers.list({
      friendlyName: `proplane-manager-${id}`,
      limit: 2,
    });
    if (matches.length > 1) return { ok: false, error: "Provider request identity is ambiguous." };
    const match = matches[0];
    if (!match) return { ok: true, number: null };
    const sid = String(match.sid ?? "").trim();
    const number = String(match.phoneNumber ?? "").trim();
    if (!sid || !number) return { ok: false, error: "Provider number identity is incomplete." };

    const attached = await client.messaging.v1.services(serviceSid).phoneNumbers.list({ limit: 1000 });
    if (!attached.some((item) => String(item.phoneNumber ?? "").trim() === number)) {
      try {
        await client.messaging.v1.services(serviceSid).phoneNumbers.create({ phoneNumberSid: sid });
      } catch {
        const recheck = await client.messaging.v1.services(serviceSid).phoneNumbers.list({ limit: 1000 });
        if (!recheck.some((item) => String(item.phoneNumber ?? "").trim() === number)) {
          return { ok: false, error: "Could not reconcile Messaging Service attachment." };
        }
      }
    }
    return { ok: true, number: { number, sid, messagingServiceSid: serviceSid } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Provider reconciliation failed." };
  }
}

/** Read-only ownership check used before clearing a stale profile cache. */
export async function twilioOwnsPhoneNumber(phone: string): Promise<boolean | null> {
  const normalized = String(phone ?? "").trim();
  const client = createTwilioRestClient();
  if (!normalized || !client) return null;
  try {
    const matches = await client.incomingPhoneNumbers.list({ phoneNumber: normalized, limit: 2 });
    return matches.some((item) => String(item.phoneNumber ?? "").trim() === normalized);
  } catch {
    return null;
  }
}

/** One provider read for periodic sender-pool drift detection. */
export async function listAttachedTwilioNumbers(): Promise<
  { ok: true; phoneNumbers: Set<string> } | { ok: false; error: string }
> {
  const serviceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const client = createTwilioRestClient();
  if (!serviceSid || !client) return { ok: false, error: "SMS provider reconciliation is not configured." };
  try {
    const rows = await client.messaging.v1.services(serviceSid).phoneNumbers.list({ limit: 1000 });
    return {
      ok: true,
      phoneNumbers: new Set(rows.map((row) => String(row.phoneNumber ?? "").trim()).filter(Boolean)),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not read the sender pool." };
  }
}

/** Release a purchased Twilio number (rollback-on-race / deliberate release). */
export async function releaseTwilioNumber(sid: string | null | undefined): Promise<boolean> {
  const s = String(sid ?? "").trim();
  if (!s) return false;
  const client = createTwilioRestClient();
  if (!client) return false;
  try {
    return await client.incomingPhoneNumbers(s).remove();
  } catch {
    return false;
  }
}

/**
 * Back-compat wrapper. The per-manager number lifecycle now lives in the
 * `manager_sms_numbers` state machine (`provisionManagerNumber`), which is
 * money-guarded (`SMS_PROVISIONING_ENABLED`) and records provider ids + state.
 * Existing callers keep the same `{ ok, number }` contract.
 *
 * Idempotent: a real stored number is returned unchanged; the legacy Claw shared
 * line is kept while the bridge is on so Twilio stays dormant during A2P review.
 */
export async function ensureManagerSmsNumber(
  db: SupabaseClient,
  managerUserId: string,
  opts?: { areaCode?: string },
): Promise<EnsureManagerSmsNumberResult> {
  if (!managerUserId) return { ok: false, error: "Missing manager id." };

  try {
    const { data: existing } = await db
      .from("profiles")
      .select("sms_from_number")
      .eq("id", managerUserId)
      .maybeSingle();
    const current = String(existing?.sms_from_number ?? "").trim();
    if (current) {
      if (isLegacyClawSharedSmsNumber(current) && isClawSharedLineBridgeEnabled()) {
        return { ok: true, number: current };
      }
      if (!isPlaceholderManagerWorkNumber(current)) {
        return { ok: true, number: current };
      }
      // Clear the placeholder stamp so the state machine can claim the slot.
      await db
        .from("profiles")
        .update({ sms_from_number: null })
        .eq("id", managerUserId)
        .eq("sms_from_number", current)
        .then(() => undefined, () => undefined);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not read the profile." };
  }

  const { provisionManagerNumber } = await import("@/lib/sms/manager-number-provisioning.server");
  const res = await provisionManagerNumber(db, managerUserId, opts);
  return res.ok ? { ok: true, number: res.number } : { ok: false, error: res.error };
}

/**
 * Read the manager's work number for SMS UI / display. Keeps the Claw shared
 * line while the bridge is on; otherwise returns the stored number (even when
 * registration is still pending — the manager should see their own number).
 * SEND-gating (registration approved) is applied separately by
 * `resolveActiveManagerSendNumber`.
 */
export async function resolveManagerWorkNumber(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  if (!managerUserId) return null;
  if (isClawSharedLineBridgeEnabled()) {
    return clawLeasingAgentPhoneE164();
  }
  const { data } = await db.from("profiles").select("sms_from_number").eq("id", managerUserId).maybeSingle();
  const current = String(data?.sms_from_number ?? "").trim();
  if (current && isLegacyClawSharedSmsNumber(current) && isClawSharedLineBridgeEnabled()) {
    return current;
  }
  if (current && !isPlaceholderManagerWorkNumber(current)) return current;
  const provisioned = await ensureManagerSmsNumber(db, managerUserId);
  return provisioned.ok ? provisioned.number : null;
}
