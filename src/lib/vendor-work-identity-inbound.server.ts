import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { normalizeE164 } from "@/lib/twilio";
import { profilePhoneVariants } from "@/lib/sms-consent";
import { bindVendorReplyTarget } from "@/lib/vendor-sponsored-outbound.server";
import { findActiveVendorNumberByPhone, loadVendorVerifiedPhone, type ActiveVendorNumber } from "@/lib/vendor-work-identity.server";
import {
  createVendorWorkIdentityDeliveryProvider,
  deliverVendorWorkIdentity,
  type VendorDeliveryProvider,
} from "@/lib/vendor-work-identity-delivery.server";
import {
  listVendorNumberConversations,
  touchVendorNumberConversation,
  workspaceNameForLine,
} from "@/lib/vendor-number-conversations.server";
import {
  VENDOR_NUMBER_NO_CONVERSATION_NOTICE,
  decideVendorReplyRoute,
  forwardedTextBody,
  replyPromptBody,
} from "@/lib/vendor-work-number";
import { resolveOwnedWorkNumber } from "@/lib/sms/resolve-owned-work-number.server";
import { runVendorNumberAiReply } from "@/lib/agent/vendor-number-ai.server";

/** Store inbound sponsored-identity mail before any assistant/support fallback. */
export async function ingestVendorWorkIdentityEmail(
  db: SupabaseClient,
  email: ParsedInboundEmail,
): Promise<{ handled: boolean; idempotent?: boolean }> {
  const destinations = [...new Set(email.toEmails.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (destinations.length === 0) return { handled: false };
  const { data: identity, error: identityError } = await db.from("vendor_work_identities")
    .select("id,vendor_user_id,email_address,email_receive_ready,email_state")
    .in("email_address", destinations)
    .eq("email_state", "ready")
    .eq("email_receive_ready", true)
    .maybeSingle();
  // A database error or more than one matching owned address is not eligible
  // for support fallback: retry the signed webhook rather than disclose it to
  // the wrong inbox.
  if (identityError) throw new Error("Vendor identity lookup unavailable.");
  const vendorUserId = String(identity?.vendor_user_id ?? "").trim();
  const address = String(identity?.email_address ?? "").trim().toLowerCase();
  if (!vendorUserId || !address || !destinations.includes(address)) return { handled: false };
  const messageId = `vendor-inbound-email:${email.emailId}`;
  const stored = await deliverPortalMessageThreadSide(db, {
    scope: scopeForRole("vendor"),
    folder: "inbox",
    ownerUserId: vendorUserId,
    participantEmail: email.fromEmail,
    otherPartyEmail: email.fromEmail,
    fallbackId: `vendor-inbound-email:${vendorUserId}:${email.fromEmail}`,
    fromName: email.fromName || email.fromEmail,
    subject: email.subject || "Message",
    body: email.text?.trim() || "(email received)",
    preview: (email.text?.trim() || "(email received)").slice(0, 100).replace(/\n/g, " "),
    when: formatPacificDateTime(new Date(email.receivedAt)),
    unread: true,
    outbound: false,
    messageId,
    channel: "email",
    messageSubject: email.subject || "Message",
  });
  await bindVendorReplyTarget(db, {
    vendorUserId,
    threadId: stored.threadId,
    channel: "email",
    recipient: email.fromEmail.trim().toLowerCase(),
    recipientUserId: null,
    messageId,
  });
  await db.from("vendor_work_identity_usage_events").upsert({
    identity_id: (identity as { id?: string }).id,
    vendor_user_id: vendorUserId,
    meter: "inbound_email",
    idempotency_key: `vendor-inbound-email:${email.emailId}`,
  }, { onConflict: "idempotency_key" });
  return { handled: true, idempotent: stored.action === "skipped" };
}

/**
 * Inbound SMS on a vendor's PropLane number. Stored even when the vendor SMS UI
 * is hidden or the monthly fair-use cap has paused outbound (inbound never
 * spends the cap). Two directions:
 *
 * - A manager's work line texted the vendor: stored in the vendor's PropLane
 *   inbox, remembered as a conversation of this number, and (forwarding on, phone
 *   verified) forwarded to the vendor's own phone as "[<Workspace>] <text>".
 * - The vendor's own verified phone texted the number (typically replying to a
 *   forward): routed to a manager by the approved rule - the most recent
 *   conversation, or a numbered "Reply to" prompt when two or more are active in
 *   24 hours or none is recent.
 *
 * - Anyone else (a client, a resident, a stranger) is stored the same way and, when it
 *   is not a manager or another vendor's number, may get an AI answer from the vendor's
 *   number. The answer runs AFTER the webhook responds: the result carries it as
 *   `afterResponse` for the route to schedule.
 *
 * STOP / START / HELP never reach this function (the webhook handles them first).
 */
export async function ingestVendorWorkIdentitySms(
  db: SupabaseClient,
  input: { toPhone: string; fromPhone: string; text: string; messageSid: string },
  deps: { provider?: VendorDeliveryProvider; now?: Date } = {},
): Promise<{ handled: boolean; idempotent?: boolean; afterResponse?: () => Promise<void> }> {
  const to = normalizeE164(input.toPhone);
  const from = normalizeE164(input.fromPhone);
  if (!to || !from || !input.messageSid) return { handled: false };
  const number = await findActiveVendorNumberByPhone(db, to);
  if (!number) return { handled: false };
  const provider = deps.provider ?? createVendorWorkIdentityDeliveryProvider();
  const verified = await loadVendorVerifiedPhone(db, number.vendorUserId);
  if (verified.verified && verified.phone === from) {
    return routeVendorOwnText(db, number, { ...input, from, text: input.text, phone: verified.phone }, provider, deps.now);
  }
  return storeAndForwardCounterpartText(db, number, { ...input, from, text: input.text }, verified, provider, deps.now);
}

async function recordInboundUsage(db: SupabaseClient, number: ActiveVendorNumber, messageSid: string): Promise<void> {
  await db.from("vendor_work_identity_usage_events").upsert({
    identity_id: number.identityId, vendor_user_id: number.vendorUserId,
    meter: "inbound_sms", idempotency_key: `vendor-inbound-sms:${messageSid}`,
  }, { onConflict: "idempotency_key" });
}

async function storeAndForwardCounterpartText(
  db: SupabaseClient,
  number: ActiveVendorNumber,
  input: { from: string; text: string; messageSid: string },
  verified: { verified: boolean; phone: string | null },
  provider: VendorDeliveryProvider,
  now?: Date,
): Promise<{ handled: boolean; idempotent?: boolean; afterResponse?: () => Promise<void> }> {
  const line = await resolveOwnedWorkNumber(db, input.from);
  const workspaceName = line ? await workspaceNameForLine(db, line) : "";
  const messageId = `vendor-inbound-sms:${input.messageSid}`;
  const body = input.text || "(text received)";
  const stored = await deliverPortalMessageThreadSide(db, {
    scope: scopeForRole("vendor"), folder: "inbox", ownerUserId: number.vendorUserId,
    participantEmail: `${input.from}@sms.proplane.local`, otherPartyEmail: `${input.from}@sms.proplane.local`,
    // The texter is a phone, not an address: the conversation is keyed by the number.
    conversation: { otherPartyPhone: input.from },
    fallbackId: `vendor-inbound-sms:${number.vendorUserId}:${input.from}`,
    fromName: workspaceName || input.from, subject: "Text message", body,
    preview: body.slice(0, 100).replace(/\n/g, " "),
    when: formatPacificDateTime(now ?? new Date()), unread: true, outbound: false, messageId, channel: "sms", messageSubject: "Text message",
  });
  await bindVendorReplyTarget(db, {
    vendorUserId: number.vendorUserId, threadId: stored.threadId, channel: "sms",
    recipient: input.from, recipientUserId: null, messageId,
  });
  await recordInboundUsage(db, number, input.messageSid);
  const duplicate = stored.action === "skipped";
  if (line) {
    await touchVendorNumberConversation(db, {
      identityId: number.identityId, vendorUserId: number.vendorUserId, counterpartPhone: input.from, direction: "inbound",
      managerUserId: line.managerId, workspaceId: line.workspaceId, workspaceName, at: now,
    });
    // A retried webhook never forwards twice (the delivery key is the message id too).
    if (!duplicate && number.forwardToPhone && verified.verified && verified.phone) {
      const forwarded = await deliverVendorWorkIdentity(db, {
        vendorUserId: number.vendorUserId, channel: "sms", recipient: verified.phone, recipientUserId: number.vendorUserId,
        subject: "Text message", text: forwardedTextBody(workspaceName, body),
        idempotencyKey: `vendor-fwd:${input.messageSid}`, sendClass: "transactional",
      }, provider);
      // A paused / STOPped / capped forward is not an error: the text is in PropLane.
      if (!forwarded.ok && !forwarded.authorized) console.info("vendor number forward skipped", forwarded.reason);
    }
  }
  // A manager's line texting a vendor is a job conversation, never answered by the AI. A retried
  // webhook (duplicate) never answers twice.
  if (!line && !duplicate && input.text.trim() && (await senderMayGetAiAnswer(db, input.from))) {
    const afterResponse = async () => {
      try {
        await runVendorNumberAiReply(
          db,
          { number, from: input.from, text: input.text, messageSid: input.messageSid, threadId: stored.threadId, now },
          { provider },
        );
      } catch (error) {
        console.error("vendor number AI reply failed", input.messageSid, error instanceof Error ? error.message : error);
      }
    };
    return { handled: true, idempotent: duplicate, afterResponse };
  }
  return { handled: true, idempotent: duplicate };
}

/**
 * The AI answers clients and residents, never PropLane staff on a job. `resolveOwnedWorkNumber`
 * already ruled out a manager's work line; this rules out another vendor's PropLane number (two
 * AIs would loop) and a manager or admin account texting from a personal phone. An unreadable
 * lookup means no AI.
 */
async function senderMayGetAiAnswer(db: SupabaseClient, from: string): Promise<boolean> {
  try {
    const { data: vendorLine, error: lineError } = await db.from("vendor_work_identities")
      .select("id").eq("phone_number", from).limit(1).maybeSingle();
    if (lineError || vendorLine) return false;
    // profiles.phone is whatever the account stored (E.164, bare 10 digits, 1+10), so look up every
    // stored form of this number and confirm each hit by normalizing its phone to E.164.
    const target = normalizeE164(from);
    if (!target) return false;
    const { data: accounts, error: accountError } = await db.from("profiles").select("id,phone")
      .in("phone", profilePhoneVariants(target)).limit(50);
    if (accountError) return false;
    const ids = ((accounts ?? []) as { id?: unknown; phone?: unknown }[])
      .filter((row) => normalizeE164(row.phone) === target)
      .map((row) => String(row.id ?? "")).filter(Boolean);
    if (ids.length === 0) return true;
    const { data: roles, error: roleError } = await db.from("profile_roles").select("role").in("user_id", ids);
    if (roleError) return false;
    return !((roles ?? []) as { role?: unknown }[]).some((row) => ["manager", "admin"].includes(String(row.role ?? "").toLowerCase()));
  } catch {
    return false;
  }
}

async function routeVendorOwnText(
  db: SupabaseClient,
  number: ActiveVendorNumber,
  input: { from: string; text: string; messageSid: string; phone: string },
  provider: VendorDeliveryProvider,
  now?: Date,
): Promise<{ handled: boolean; idempotent?: boolean }> {
  await recordInboundUsage(db, number, input.messageSid);
  const conversations = await listVendorNumberConversations(db, number.identityId);
  const decision = decideVendorReplyRoute(conversations, input.text, now);
  const reply = (text: string, key: string) => deliverVendorWorkIdentity(db, {
    vendorUserId: number.vendorUserId, channel: "sms", recipient: input.phone, recipientUserId: number.vendorUserId,
    subject: "Text message", text, idempotencyKey: key, sendClass: "transactional",
  }, provider);
  if (decision.kind === "none") {
    await reply(VENDOR_NUMBER_NO_CONVERSATION_NOTICE, `vendor-route-none:${input.messageSid}`);
    return { handled: true };
  }
  if (decision.kind === "prompt") {
    await reply(replyPromptBody(decision.choices), `vendor-route-prompt:${input.messageSid}`);
    return { handled: true };
  }
  const target = conversations.find((c) => c.counterpartPhone === decision.counterpartPhone);
  const delivered = await deliverVendorWorkIdentity(db, {
    vendorUserId: number.vendorUserId, channel: "sms", recipient: decision.counterpartPhone, recipientUserId: null,
    subject: "Text message", text: decision.body, idempotencyKey: `vendor-route:${input.messageSid}`,
    contextFingerprint: `route:${decision.counterpartPhone}|body:${decision.body}`, sendClass: "transactional",
  }, provider);
  if (!delivered.ok && !delivered.authorized) {
    console.info("vendor number reply not delivered", delivered.reason);
    return { handled: true };
  }
  await touchVendorNumberConversation(db, {
    identityId: number.identityId, vendorUserId: number.vendorUserId, counterpartPhone: decision.counterpartPhone,
    direction: "outbound", workspaceName: target?.workspaceName, at: now,
  });
  // The vendor's PropLane inbox shows their own text in that manager's thread.
  await deliverPortalMessageThreadSide(db, {
    scope: scopeForRole("vendor"), folder: "inbox", ownerUserId: number.vendorUserId,
    participantEmail: `${decision.counterpartPhone}@sms.proplane.local`, otherPartyEmail: `${decision.counterpartPhone}@sms.proplane.local`,
    conversation: { otherPartyPhone: decision.counterpartPhone },
    fallbackId: `vendor-inbound-sms:${number.vendorUserId}:${decision.counterpartPhone}`,
    fromName: target?.workspaceName || decision.counterpartPhone, subject: "Text message", body: decision.body,
    preview: decision.body.slice(0, 100).replace(/\n/g, " "),
    when: formatPacificDateTime(now ?? new Date()), unread: false, outbound: true,
    messageId: `vendor-route-sms:${input.messageSid}`, channel: "sms", messageSubject: "Text message",
  });
  return { handled: true };
}
