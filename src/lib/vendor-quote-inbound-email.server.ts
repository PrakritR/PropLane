import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadVendorQuoteInboundReplyCapability } from "@/lib/vendor-quote-contact.server";
import { fetchResendReceivedEmailBodyWithRetry, htmlToText, type ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { stripEmailReplyQuote } from "@/lib/inbound-email/strip-email-reply-quote";
import { notifyVendorQuoteResponse } from "@/lib/vendor-quote-notification.server";

/** Signed-provider caller only. Native email proves this candidate's reply
 * provenance, never phone possession, a price acceptance or booking authority. */
export async function ingestVendorQuoteInboundEmail(db: SupabaseClient, parsed: ParsedInboundEmail, payload: unknown): Promise<{ handled: boolean }> {
  const domain = process.env.RESEND_REPLY_DOMAIN?.trim().toLowerCase();
  if (!domain) return { handled: false };
  const recipient = parsed.toEmails.map((email) => email.trim().toLowerCase()).find((email) => email.endsWith(`@${domain}`) && /^vq\+[a-z2-7]{52}@/.test(email));
  if (!recipient) return { handled: false };
  const token = recipient.slice(3, recipient.indexOf("@"));
  const cap = await loadVendorQuoteInboundReplyCapability(db, { token, fromEmail: parsed.fromEmail });
  // Recognized capability mail never falls into a different pair/assistant route.
  if (!cap) return { handled: true };
  const envelope = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : {};
  const headers = JSON.stringify(data.headers ?? {}).toLowerCase();
  if (/\b(?:automatic reply|auto.?reply|out of office|delivery status notification|undeliverable)\b/i.test(parsed.subject) || /auto-submitted|x-autoreply|x-autorespond/.test(headers)) return { handled: true };
  let raw = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : "");
  if (!raw) {
    const fetched = await fetchResendReceivedEmailBodyWithRetry(parsed.emailId);
    if (fetched.kind !== "body") throw new Error("Quote email body unavailable; provider retry required.");
    raw = fetched.text;
  }
  if (raw.split(/\r?\n/).filter((line) => line.trim()).every((line) => /^\s*>/.test(line))) return { handled: true };
  const body = stripEmailReplyQuote(raw).trim().slice(0, 6000);
  if (!body) return { handled: true };
  await notifyVendorQuoteResponse(db, { capabilityId: cap.capabilityId, sourceMessageId: `vendor-quote-email:${parsed.emailId}`, body, channel: "email" });
  const { error } = await db.from("vendor_sourcing_candidates").update({ status: "responding", reason: "Vendor replied by email. Review the service conversation.", updated_at: new Date().toISOString() }).eq("id", cap.candidateId).eq("manager_user_id", cap.managerUserId);
  if (error) throw new Error("Quote email reply state could not be saved.");
  return { handled: true };
}
