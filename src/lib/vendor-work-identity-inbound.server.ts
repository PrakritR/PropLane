import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { normalizeE164 } from "@/lib/twilio";
import { bindVendorReplyTarget } from "@/lib/vendor-sponsored-outbound.server";

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

/** Inbound SMS is stored even when the vendor SMS UI is hidden or outbound is capped. */
export async function ingestVendorWorkIdentitySms(
  db: SupabaseClient,
  input: { toPhone: string; fromPhone: string; text: string; messageSid: string },
): Promise<{ handled: boolean; idempotent?: boolean }> {
  const to = normalizeE164(input.toPhone);
  const from = normalizeE164(input.fromPhone);
  if (!to || !from || !input.messageSid) return { handled: false };
  const { data: identity, error: identityError } = await db.from("vendor_work_identities")
    .select("id,vendor_user_id,phone_number,sms_state,sms_receive_ready,attachment_state")
    .eq("phone_number", to)
    .eq("sms_state", "ready")
    .eq("sms_receive_ready", true)
    .eq("attachment_state", "attached")
    .maybeSingle();
  if (identityError) throw new Error("Vendor identity lookup unavailable.");
  const vendorUserId = String(identity?.vendor_user_id ?? "").trim();
  if (!vendorUserId) return { handled: false };
  const messageId = `vendor-inbound-sms:${input.messageSid}`;
  const stored = await deliverPortalMessageThreadSide(db, {
    scope: scopeForRole("vendor"), folder: "inbox", ownerUserId: vendorUserId,
    participantEmail: `${from}@sms.proplane.local`, otherPartyEmail: `${from}@sms.proplane.local`,
    fallbackId: `vendor-inbound-sms:${vendorUserId}:${from}`,
    fromName: from, subject: "Text message", body: input.text || "(text received)",
    preview: (input.text || "(text received)").slice(0, 100).replace(/\n/g, " "),
    when: formatPacificDateTime(new Date()), unread: true, outbound: false, messageId, channel: "sms", messageSubject: "Text message",
  });
  await bindVendorReplyTarget(db, {
    vendorUserId,
    threadId: stored.threadId,
    channel: "sms",
    recipient: from,
    recipientUserId: null,
    messageId,
  });
  await db.from("vendor_work_identity_usage_events").upsert({
    identity_id: (identity as { id?: string }).id, vendor_user_id: vendorUserId,
    meter: "inbound_sms", idempotency_key: `vendor-inbound-sms:${input.messageSid}`,
  }, { onConflict: "idempotency_key" });
  return { handled: true, idempotent: stored.action === "skipped" };
}
