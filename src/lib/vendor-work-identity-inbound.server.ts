import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { formatPacificDateTime } from "@/lib/pacific-time";
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
