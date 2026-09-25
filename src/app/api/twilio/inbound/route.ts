import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeConsentPhone, readSmsSuppressionState } from "@/lib/sms-consent";
import { resolveWorkspaceOwnerForWorkNumber } from "@/lib/sms/manager-workspace-role.server";
import { inboundLogIdentityFields } from "@/lib/manager-sms-messages.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { fetchTwilioMessageCreatedAt, twilioWebhookAuthToken } from "@/lib/twilio-client.server";
import { loadInboundReplay } from "@/lib/sms/inbound-replay.server";
import {
  inboundMediaParams,
  inboundRuntime,
  runClaimedInbound,
  twimlOk,
  type InboundPayload,
} from "@/lib/sms/inbound-pipeline.server";
import { resolveOwnedWorkNumber } from "@/lib/sms/resolve-owned-work-number.server";
import { ingestVendorWorkIdentitySms } from "@/lib/vendor-work-identity-inbound.server";

export const runtime = "nodejs";
// ponytail: room for the QStash-outage fallback (quiet window + agent turn) in after().
export const maxDuration = 120;

/**
 * Standard carrier/Twilio SMS control keywords. Twilio's Advanced Opt-Out sends
 * the compliance auto-replies; Axis records the resulting consent state so it
 * never texts an opted-out number again, and never leaks a control message into
 * anyone's inbox. Matched case-insensitively against the entire trimmed body.
 */
const SMS_STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const SMS_START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const SMS_HELP_KEYWORDS = new Set(["HELP", "INFO"]);

/**
 * Twilio inbound SMS webhook for manager work numbers.
 *
 * Any From phone is accepted (no allowlist). Managed-runtime messages route
 * through the durable receipt claim and then leasing bot / resident intents /
 * manager agent commands. The legacy relay pool is runtime-off only.
 *
 * Configure in Twilio: Messaging webhook → POST https://<host>/api/twilio/inbound
 * (must match TWILIO_WEBHOOK_URL when set, for signature validation).
 */
export async function POST(req: Request) {
  const started = Date.now();
  const marks: string[] = [];
  const mark = (step: string) => { marks.push(`${step}:${Date.now() - started}`); };
  let status = 500;
  let error: string | undefined;
  try {
    const res = await handleInbound(req, mark);
    status = res.status;
    if (status >= 500) error = (await res.clone().text()).slice(0, 200).replace(/\+?\d{7,}/g, "[redacted]");
    return res;
  } finally {
    const ms = Date.now() - started;
    // ponytail: log only slow or failed requests; Twilio abandons the webhook at 15s.
    if (ms > 5000 || status >= 500) console.warn("twilio inbound timing", { status, ms, error, marks: marks.join(" ") });
  }
}

async function handleInbound(req: Request, mark: (step: string) => void): Promise<NextResponse> {
  const authToken = twilioWebhookAuthToken();
  if (!authToken) return NextResponse.json({ error: "SMS not configured." }, { status: 503 });

  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));

  // Signature check — reject spoofed webhook calls. Fail closed on Vercel.
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = process.env.TWILIO_WEBHOOK_URL?.trim() || req.url;
  const failClosed = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  if (!signature) {
    if (failClosed) return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  } else if (!twilio.validateRequest(authToken, signature, url, params)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  const fromPhone = String(params.From ?? "").trim();
  const toPhone = String(params.To ?? "").trim();
  const body = String(params.Body ?? "").trim();
  const messageSid = String(params.MessageSid ?? "").trim() || null;
  if (!fromPhone || !toPhone) return twimlOk();
  mark("signed");

  // Real-customer shield: outside production, a text from (or to) a protected
  // account is acknowledged and dropped. Processing it would file rows and can
  // trigger an agent auto-reply, and staging runs on a clone of production so
  // the person on the other end is real.
  const { isShieldedRecipient } = await import("@/lib/protected-accounts.server");
  if (
    (await isShieldedRecipient({ phone: fromPhone })) ||
    (await isShieldedRecipient({ phone: toPhone }))
  ) {
    console.error("protected-accounts: dropped an inbound text on a non-production runtime.");
    return twimlOk();
  }

  mark("shield");
  const db = createSupabaseServiceRoleClient();
  const ownedNumber = await resolveOwnedWorkNumber(db, toPhone);
  mark("owned-number");

  // Compliance controls run before traffic shedding so a legitimate STOP can
  // never be discarded by the ordinary inbound rate limiter.
  const keyword = body.toUpperCase();
  let controlKeyword: "STOP" | "START" | "HELP" | null = SMS_STOP_KEYWORDS.has(keyword)
    ? "STOP"
    : SMS_START_KEYWORDS.has(keyword)
      ? "START"
      : SMS_HELP_KEYWORDS.has(keyword)
        ? "HELP"
        : null;

  // "YES" is both a carrier opt-in synonym and the natural way to approve an
  // agent proposal by text. Compliance runs first, so without this the reply a
  // resident sends to confirm a rent payment is silently eaten as an opt-in and
  // the proposal is never confirmed.
  //
  // Precedence is resolved by STATE, not by guessing intent: opting in is only
  // meaningful for a phone that is currently opted OUT, and a suppressed phone
  // was never sent a proposal in the first place. So START keeps priority while
  // suppressed, and otherwise the message falls through to the agent. STOP and
  // HELP are never reinterpreted — those must work unconditionally.
  if (controlKeyword === "START") {
    const suppression = await readSmsSuppressionState(db, fromPhone);
    // Unreadable suppression falls back to carrier handling: treating an
    // unknown state as "not opted out" could swallow a genuine opt-in.
    if (suppression.ok && !suppression.optedOut) controlKeyword = null;
  }

  if (controlKeyword) {
    const phoneKey = normalizeConsentPhone(fromPhone);
    if (!messageSid || !phoneKey) {
      return NextResponse.json({ error: "Invalid control message." }, { status: 400 });
    }
    const providerOccurredAt = await fetchTwilioMessageCreatedAt(messageSid);
    if (!providerOccurredAt) {
      return NextResponse.json({ error: "Control message time unavailable." }, { status: 503 });
    }
    const { error: controlError } = await db.rpc("apply_sms_control_keyword", {
      p_message_sid: messageSid,
      p_recipient_phone_key: phoneKey,
      p_keyword: controlKeyword,
      p_provider_occurred_at: providerOccurredAt,
      p_manager_user_id: ownedNumber?.managerId ?? null,
      p_messaging_service_sid: ownedNumber?.messagingServiceSid ?? null,
    });
    if (controlError) {
      // Non-2xx asks Twilio to retry; the RPC is atomic and MessageSid-unique.
      return NextResponse.json({ error: "Control receipt unavailable." }, { status: 503 });
    }
    return twimlOk();
  }

  // Vendor identities are resolved before manager-only work-number ownership.
  // Inbound never consumes a manager credit/cap and remains visible with the
  // SMS UI feature flag off.
  if (messageSid) {
    try {
      const vendorInbound = await ingestVendorWorkIdentitySms(db, { toPhone, fromPhone, text: body, messageSid });
      if (vendorInbound.handled) return twimlOk();
    } catch (error) {
      console.error("vendor inbound SMS ingest failed", messageSid, error);
      return NextResponse.json({ error: "Vendor inbox unavailable." }, { status: 503 });
    }
  }

  mark("controls");
  // Pooled proxy lines are retired. Only owned work numbers route replies.
  const numberOwnerId = ownedNumber?.managerId ?? "";
  if (!numberOwnerId) {
    const limit = await rateLimit(`twilio-inbound:${fromPhone}`, 20, 60_000);
    if (limit.unavailable) return NextResponse.json({ error: "Rate limit store unavailable." }, { status: 503 });
    if (!limit.ok) {
      return twimlOk();
    }
    await db
      .from("inbound_sms_log")
      .insert({
        from_phone: fromPhone,
        to_phone: toPhone,
        body,
        message_sid: messageSid,
        ...inboundLogIdentityFields({ managerUserId: null, counterpartyRole: "unknown", fromPhone }),
      })
      .then(() => undefined, () => undefined);
    return twimlOk();
  }

  // A work number is the WORKSPACE's front door, not the row it was bought
  // under. A line still held by a pure co-manager (bought before numbers became
  // workspace-owned) answers for the owner whose houses they manage: residents
  // resolve against the owner's rows, prospects reach the owner's leasing
  // agent, and every thread lands in the owner's inbox — where the co-manager
  // already reads it. The texter never learns which teammate set the line up.
  let managerId: string;
  try {
    managerId = (
      await resolveWorkspaceOwnerForWorkNumber(db, numberOwnerId, {
        throwOnError: true,
        workspaceId: ownedNumber?.workspaceId ?? null,
      })
    ).ownerUserId;
  } catch {
    return NextResponse.json({ error: "Workspace unavailable." }, { status: 503 });
  }

  mark("workspace");
  if (!messageSid) {
    return NextResponse.json({ error: "MessageSid is required." }, { status: 400 });
  }
  const inboundPhoneKey = normalizeConsentPhone(fromPhone);
  if (!inboundPhoneKey) {
    return NextResponse.json({ error: "Invalid sender phone." }, { status: 400 });
  }

  // Count a provider MessageSid against the abuse limit only before its first
  // durable receipt exists. Twilio retries of a failed/leased message must not
  // consume the sender's quota and then get acknowledged before replay can
  // finish; that would turn a retry storm into silent message loss.
  const replayBeforeClaim = await loadInboundReplay(db, messageSid);
  if (!replayBeforeClaim.ok) {
    return NextResponse.json({ error: "Inbound replay state unavailable." }, { status: 503 });
  }
  if (!replayBeforeClaim.receipt) {
    const limit = await rateLimit(`twilio-inbound:${fromPhone}`, 20, 60_000);
    if (limit.unavailable) return NextResponse.json({ error: "Rate limit store unavailable." }, { status: 503 });
    if (!limit.ok) return twimlOk();
  }
  mark("rate-limit");
  const inboundWorkerId = `inbound-${randomUUID()}`;
  // Stored atomically with the claim so the recovery sweeper can always rerun it.
  const payload: InboundPayload = {
    fromPhone, toPhone, body,
    workspaceId: ownedNumber?.workspaceId ?? null,
    media: inboundMediaParams(params),
    runtime: inboundRuntime(),
  };
  const { data: inboundClaimed, error: inboundClaimError } = await db.rpc("claim_sms_inbound", {
    p_message_sid: messageSid,
    p_manager_user_id: managerId,
    p_recipient_phone_key: inboundPhoneKey,
    p_worker_id: inboundWorkerId,
    p_lease_seconds: 120,
    p_inbound_payload: payload,
  });
  if (inboundClaimError) {
    return NextResponse.json({ error: "Inbound receipt unavailable." }, { status: 503 });
  }
  if (inboundClaimed !== true) {
    // `false` can mean either a completed replay OR another worker/failed
    // completion still owns the lease. Acknowledging both would make Twilio
    // stop retrying a message whose reply was never durably completed.
    const { data: receipt, error: receiptError } = await db
      .from("sms_inbound_receipts")
      .select("status")
      .eq("message_sid", messageSid)
      .maybeSingle();
    if (receiptError || receipt?.status !== "completed") {
      return NextResponse.json({ error: "Inbound processing is still pending." }, { status: 503 });
    }
    return twimlOk();
  }

  mark("claimed");
  return runClaimedInbound(db, { ...payload, messageSid, managerId, inboundWorkerId, mark });
}
