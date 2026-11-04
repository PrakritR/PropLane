import { processVendorQuoteSmsChallenge, reconcileVendorQuoteSmsOutcome } from "@/lib/vendor-quote-contact.server";
import { isVendorQuoteProofBody, openVendorQuoteCode, REDACTED_QUOTE_BODY, type ClaimedSmsIngressContext } from "@/lib/sms/vendor-quote-ingress.server";
import { NextResponse, after } from "next/server";
import { randomUUID } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeConsentPhone, readSmsSuppressionState } from "@/lib/sms-consent";
import { resolveWorkspaceOwnerForWorkNumber } from "@/lib/sms/manager-workspace-role.server";
import { inboundLogIdentityFields } from "@/lib/manager-sms-messages.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { fetchTwilioMessageCreatedAt } from "@/lib/twilio-client.server";
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
import { resolveVendorNumberSenderPhone } from "@/lib/vendor-work-identity.server";
import { ingestResidentAgentNumberSms } from "@/lib/resident-agent-number/inbound.server";
import { isSharedLineNumber, loadSharedLineConfig, loadSharedLineConfigStrict } from "@/lib/one-number/config.server";
import { endDemoForPhone } from "@/lib/one-number/demo/store.server";
import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { isOldNumberOnSharedLine, sendMovedAutoReply } from "@/lib/one-number/old-number.server";
import { recordShadowDecision } from "@/lib/one-number/shadow.server";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";

import { durableSmsCheckpoint, getDurableSmsCheckpoint, SafeSmsIngressRetry, isDurableSmsIngress } from "@/lib/sms/durable-ingress-context.server";
import type { PreparedBubble } from "@/lib/sms/inbound-envelope.server";
const SMS_STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const SMS_START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const SMS_HELP_KEYWORDS = new Set(["HELP", "INFO"]);


export async function processAcceptedInbound(params: Record<string, string>, contextOrMark?: ClaimedSmsIngressContext | ((step: string) => void)): Promise<{ bubbles: PreparedBubble[]; sender?: string }> {
  const mark = typeof contextOrMark === "function" ? contextOrMark : () => undefined;
  const context = typeof contextOrMark === "object" ? contextOrMark : undefined;
  const prepared: PreparedBubble[] = [];
  const state: { sender?: string } = {};
  const response = await processInboundParams(params, prepared, mark, state, context);
  if (response.status >= 300) throw new Error(`Inbound processing returned ${response.status}`);
  return { bubbles: prepared, ...state };
}

export async function processInboundParams(params: Record<string, string>, prepared: PreparedBubble[], mark: (step: string) => void, state: { sender?: string }, context?: ClaimedSmsIngressContext): Promise<NextResponse> {
  const fromPhone = String(params.From ?? "").trim();
  // `let`: a text to an old work number that has moved to the shared line continues as a shared-line text.
  let toPhone = String(params.To ?? "").trim();
  // A texted card or bank number is replaced with [redacted] before anything
  // stores or reads the body: the receipt, the projection, the inbound log and
  // the agent all see the redacted text.
  const redaction = redactSensitiveNumbers(String(params.Body ?? "").trim());
  const body = redaction.text;
  const messageSid = String(params.MessageSid ?? "").trim() || null;
  if (!fromPhone || !toPhone) return twimlOk();
  mark("signed");


  const db = createSupabaseServiceRoleClient();
  if (getDurableSmsCheckpoint()?.stage === "unstarted") await durableSmsCheckpoint({ stage: "safe" });
  // Durable acceptance must never reinterpret an unreadable shared line as an owned line.
  let resolvedNumber: Awaited<ReturnType<typeof resolveOwnedWorkNumber>>;
  let lineConfig: Awaited<ReturnType<typeof loadSharedLineConfig>>;
  try {
    resolvedNumber = await resolveOwnedWorkNumber(db, toPhone);
    if (isDurableSmsIngress()) {
      const read = await loadSharedLineConfigStrict(db);
      if (!read.ok) throw new SafeSmsIngressRetry("routing_config_unavailable");
      lineConfig = read.config;
    } else lineConfig = await loadSharedLineConfig(db);
  } catch (error) {
    if (isDurableSmsIngress()) throw new SafeSmsIngressRetry("routing_dependency_unavailable");
    throw error;
  }
  let ownedNumber: { managerId: string; workspaceId: string | null; messagingServiceSid: string } | null = resolvedNumber;
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
  const savedControl = getDurableSmsCheckpoint();
  if (savedControl?.stage === "control") controlKeyword = savedControl.controlKeyword as typeof controlKeyword;
  if (controlKeyword === "START" && savedControl?.stage !== "control") {
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
    await durableSmsCheckpoint({ stage: "control", controlKeyword });
    let providerOccurredAt: string | null;
    try { providerOccurredAt = await fetchTwilioMessageCreatedAt(messageSid); }
    catch (error) {
      if (isDurableSmsIngress()) throw new SafeSmsIngressRetry("control_timestamp_unavailable");
      throw error;
    }
    if (!providerOccurredAt) {
      if (isDurableSmsIngress()) throw new SafeSmsIngressRetry("control_timestamp_unavailable");
      return NextResponse.json({ error: "Control message time unavailable." }, { status: 503 });
    }
    let controlError;
    try { ({ error: controlError } = await db.rpc("apply_sms_control_keyword", {
      p_message_sid: messageSid,
      p_recipient_phone_key: phoneKey,
      p_keyword: controlKeyword,
      p_provider_occurred_at: providerOccurredAt,
      p_manager_user_id: ownedNumber?.managerId ?? null,
      p_messaging_service_sid: ownedNumber?.messagingServiceSid ?? null,
    })); } catch (error) {
      if (isDurableSmsIngress()) throw new SafeSmsIngressRetry("control_receipt_unavailable");
      throw error;
    }
    if (controlError) {
      // The MessageSid-idempotent control RPC is safe to replay after durable ACK.
      if (isDurableSmsIngress()) throw new SafeSmsIngressRetry("control_receipt_unavailable");
      return NextResponse.json({ error: "Control receipt unavailable." }, { status: 503 });
    }
    // STOP ends a sandbox demo on this phone (best effort; the opt-out above is the record).
    if (controlKeyword === "STOP") await endDemoForPhone(db, phoneKey).catch(() => undefined);
    return twimlOk();
  }

  // Quote consent is the sole replay-safe grant transaction, before any general effect.
  // Neither a provider marker nor routed/aliased phones can establish its authority.
  if (isVendorQuoteProofBody(body) || context?.quoteCapsule) {
    if (!context || body !== REDACTED_QUOTE_BODY || params.PropLaneRedacted !== "1" ||
      params.From !== context.wireFrom || params.To !== context.wireTo || params.MessageSid !== context.messageSid ||
      params.AccountSid !== context.accountSid || (params.MessagingServiceSid || null) !== context.providerMessagingServiceSid) return twimlOk();
    try {
      const identity = { fromPhone: context.wireFrom, toPhone: context.wireTo, messageSid: context.messageSid,
        providerMessagingServiceSid: context.providerMessagingServiceSid };
      const committed = await reconcileVendorQuoteSmsOutcome(db, identity);
      if (committed === "committed") {
        await durableSmsCheckpoint({ stage: "delegated", delegatedSid: context.messageSid });
        return twimlOk();
      }
      if (committed === "conflict" || !context.quoteCapsule) return twimlOk();
      // Configuration absence is a dependency failure, unlike malformed/rotated ciphertext.
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new SafeSmsIngressRetry("quote_key_unavailable");
      const code = openVendorQuoteCode(context.quoteCapsule, context, context.quoteCapsuleExpiresAt);
      if (!code) return twimlOk();
      const limit = await rateLimit(`twilio-quote-proof:${context.wireFrom}`, 10, 60_000);
      if (limit.unavailable) throw new SafeSmsIngressRetry("quote_rate_limit_unavailable");
      if (!limit.ok) return twimlOk();
      const outcome = await processVendorQuoteSmsChallenge(db, { ...identity, body: `QUOTE ${code}` });
      if (outcome.granted) {
        // The legacy endpoint may have won the same-SID race. Require the atomic originals too.
        if (await reconcileVendorQuoteSmsOutcome(db, identity) !== "committed") return twimlOk();
        await durableSmsCheckpoint({ stage: "delegated", delegatedSid: context.messageSid });
      }
      return twimlOk();
    } catch {
      // This catch encloses reads and only the SID-idempotent consent RPC, never generic effects.
      throw new SafeSmsIngressRetry("quote_proof_dependency_unavailable");
    }
  }

  // One-number shared line (docs/agents/one-number.md): a text to the shared number is stamped with a
  // workspace here, before any agent runs. A routed text then continues below exactly as a work-number
  // text would, as that workspace's owner. Only live in `shared` mode; every other mode skips this.
  let sharedLine = false;
  // An OLD per-workspace number whose workspace now answers on the shared line (not a dedicated one):
  // the sender is told once per 30 days where we moved (PropLane's cost), and the text goes through the
  // shared-line router below as if it had arrived there, so nothing is lost. Dedicated workspaces and
  // every other mode skip this.
  const oldNumberMoved = Boolean(messageSid) && isOldNumberOnSharedLine(lineConfig, toPhone, resolvedNumber);
  const oldNumberTo = toPhone;
  if (oldNumberMoved && lineConfig.sharedNumber) toPhone = lineConfig.sharedNumber;
  if (lineConfig.mode === "shared" && messageSid && isSharedLineNumber(lineConfig, toPhone)) {
    const sharedKey = normalizeConsentPhone(fromPhone);
    if (sharedKey) {
      const limit = await rateLimit(`twilio-shared-line:${fromPhone}`, 20, 60_000);
      if (limit.unavailable) {
        if (isDurableSmsIngress()) throw new SafeSmsIngressRetry("shared_rate_limit_unavailable");
        return NextResponse.json({ error: "Rate limit store unavailable." }, { status: 503 });
      }
      if (!limit.ok) return twimlOk();
      await durableSmsCheckpoint({ stage: "effect" });
      if (oldNumberMoved && resolvedNumber?.workspaceId) {
        await sendMovedAutoReply(db, {
          config: lineConfig, phoneKey: sharedKey, fromPhone, workspaceId: resolvedNumber.workspaceId, messageSid: messageSid!,
        }).catch((error) => console.error("moved-number reply failed", messageSid, error instanceof Error ? error.name : "unknown"));
      }
      try {
        const seam = await handleSharedLineInbound(db, {
          config: lineConfig,
          fromPhone,
          body,
          messageSid,
          mediaCount: Number(params.NumMedia) || 0,
          phoneKey: sharedKey,
        });
        if (seam.kind === "handled") {
          const bubbles: Array<{ body: string; mediaUrl?: string }> = seam.bubbles ?? (seam.messages?.map((body) => ({ body })) ?? (seam.twiml ? [{ body: seam.twiml, mediaUrl: seam.mediaUrl }] : []));
          state.sender = lineConfig.sharedNumber ?? undefined;
          prepared.push(...bubbles.map((bubble) => ({ body: bubble.body, ...(bubble.mediaUrl ? { mediaUrls: [bubble.mediaUrl] } : {}) })));
          return twimlOk();
        }
        if (seam.kind === "continue") {
          ownedNumber = { ...seam.owned };
          sharedLine = true;
        }
      } catch (error) {
        if (isDurableSmsIngress()) throw error;
        // Fall through to the no-owner path below, which keeps the text in the inbound log.
        console.error("shared line routing failed", messageSid, error instanceof Error ? error.name : "unknown");
      }
    }
  }
  // The shared line took nothing from an old-number text: it continues on the old number exactly as before.
  if (oldNumberMoved && !sharedLine) toPhone = oldNumberTo;
  mark("shared-line");

  await durableSmsCheckpoint({ stage: "effect" });
  // Vendor identities are resolved before manager-only work-number ownership.
  // Inbound never consumes a manager credit/cap and remains visible with the
  // SMS UI feature flag off.
  if (messageSid) {
    try {
      const vendorInbound = await ingestVendorWorkIdentitySms(db, { toPhone, fromPhone, text: body, messageSid });
      if (vendorInbound.handled) {
        // The AI answer (clients and residents only) runs after Twilio has its response.
        const aiAnswer = vendorInbound.afterResponse;
        if (aiAnswer) after(() => aiAnswer());
        return twimlOk();
      }
    } catch (error) {
      console.error("vendor inbound SMS ingest failed", messageSid, error);
      return NextResponse.json({ error: "Vendor inbox unavailable." }, { status: 503 });
    }
  }

  // A subscribed resident's own PropLane number (their personal agent). Flag-gated inside: with
  // NUMBER_SUBSCRIPTION_ENABLED off this is a no-op that costs no query.
  if (messageSid) {
    try {
      const residentInbound = await ingestResidentAgentNumberSms(db, { toPhone, fromPhone, text: body, messageSid });
      if (residentInbound.handled) {
        const agentReply = residentInbound.afterResponse;
        if (agentReply) after(() => agentReply());
        return twimlOk();
      }
    } catch (error) {
      console.error("resident agent inbound SMS ingest failed", messageSid, error);
      return NextResponse.json({ error: "Resident inbox unavailable." }, { status: 503 });
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
  // A vendor texting this line from their PropLane work number is the vendor on
  // the owner's list: the sender becomes the phone that roster row carries, so
  // the whole pipeline below (thread, consent, history) sees one vendor.
  let senderPhone = fromPhone;
  try {
    senderPhone = (await resolveVendorNumberSenderPhone(db, { fromPhone, ownerManagerUserId: managerId })) ?? fromPhone;
  } catch {
    return NextResponse.json({ error: "Vendor number lookup unavailable." }, { status: 503 });
  }
  const inboundPhoneKey = normalizeConsentPhone(senderPhone);
  if (!inboundPhoneKey) {
    return NextResponse.json({ error: "Invalid sender phone." }, { status: 400 });
  }
  // Shadow mode: record what the shared-line router would have decided, next to the real owner.
  // After the response, read-only; a failure here never touches this request.
  if (lineConfig.mode === "shadow" && !sharedLine) {
    const shadowOwner = managerId;
    const shadowWorkspace = ownedNumber?.workspaceId ?? null;
    const shadowInbound = {
      fromPhone: senderPhone, phoneKey: inboundPhoneKey, body, messageSid, mediaCount: Number(params.NumMedia) || 0,
    };
    after(async () => {
      await recordShadowDecision(createSupabaseServiceRoleClient(), {
        inbound: shadowInbound, actualOwnerUserId: shadowOwner, actualWorkspaceId: shadowWorkspace,
      });
    });
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
    const limit = await rateLimit(`twilio-inbound:${senderPhone}`, 20, 60_000);
    if (limit.unavailable) return NextResponse.json({ error: "Rate limit store unavailable." }, { status: 503 });
    if (!limit.ok) return twimlOk();
  }
  mark("rate-limit");
  const inboundWorkerId = `inbound-${randomUUID()}`;
  // Stored atomically with the claim so the recovery sweeper can always rerun it.
  const payload: InboundPayload = {
    fromPhone: senderPhone, toPhone, body,
    ...((redaction.redacted || params.PropLaneRedacted === "1") ? { redacted: true } : {}),
    workspaceId: ownedNumber?.workspaceId ?? null,
    media: inboundMediaParams(params),
    runtime: inboundRuntime(),
    // Stored with the receipt so a recovery rerun still honors a HUMAN pause on the shared line.
    ...(sharedLine ? { sharedLine: true } : {}),
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
    if (!receiptError && receipt) await durableSmsCheckpoint({ stage: "delegated", delegatedSid: messageSid });
    if (receiptError || receipt?.status !== "completed") {
      return NextResponse.json({ error: "Inbound processing is still pending." }, { status: 503 });
    }
    return twimlOk();
  }

  await durableSmsCheckpoint({ stage: "delegated", delegatedSid: messageSid });
  mark("claimed");
  return runClaimedInbound(db, { ...payload, messageSid, managerId, inboundWorkerId, mark });
}
