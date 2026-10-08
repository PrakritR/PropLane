import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { loadVendorVerifiedPhone } from "@/lib/vendor-work-identity.server";
import { deliverVendorWorkIdentity, type VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";

const HANDOFF_FORWARD_MAX = 320;

/**
 * Hand a text to the vendor: a note in their PropLane inbox thread with that
 * sender and, when the vendor takes forwards, a text to their verified phone.
 * It sends nothing to the sender and changes nothing else. Idempotent on the
 * inbound message sid, so a repeated tool call or a retried webhook notifies once.
 */
export async function handOffToVendor(
  db: SupabaseClient,
  args: {
    vendorUserId: string;
    senderPhone: string;
    senderText: string;
    messageSid: string;
    reason: string;
    forwardToPhone: boolean;
    provider: VendorDeliveryProvider;
    now?: Date;
  },
): Promise<{ noted: boolean; forwarded: boolean }> {
  const reason = args.reason.trim().replace(/\s+/g, " ").slice(0, 200) || "Needs your attention.";
  const sender = `${args.senderPhone}@sms.proplane.local`;
  const note = `Needs you: ${reason}`;
  let noted = false;
  try {
    await deliverPortalMessageThreadSide(db, {
      scope: scopeForRole("vendor"), folder: "inbox", ownerUserId: args.vendorUserId,
      participantEmail: sender, otherPartyEmail: sender,
      conversation: { otherPartyPhone: args.senderPhone },
      fallbackId: `vendor-inbound-sms:${args.vendorUserId}:${args.senderPhone}`,
      fromName: "PropLane AI", subject: "Text message", body: note, preview: note.slice(0, 100),
      when: formatPacificDateTime(args.now ?? new Date()), unread: true, outbound: false,
      messageId: `vendor-ai-handoff:${args.messageSid}`, channel: "proplane", automated: true,
    });
    noted = true;
  } catch (error) {
    console.error("vendor number AI handoff note failed", error instanceof Error ? error.message : error);
  }

  let forwarded = false;
  if (args.forwardToPhone) {
    const verified = await loadVendorVerifiedPhone(db, args.vendorUserId);
    if (verified.verified && verified.phone) {
      const who = formatSmsPhoneLabel(args.senderPhone) ?? args.senderPhone;
      const text = `Needs you. ${who} texted: "${args.senderText.trim().replace(/\s+/g, " ").slice(0, 140)}". ${reason}`.slice(0, HANDOFF_FORWARD_MAX);
      const result = await deliverVendorWorkIdentity(db, {
        vendorUserId: args.vendorUserId, channel: "sms", recipient: verified.phone, recipientUserId: args.vendorUserId,
        subject: "Text message", text, idempotencyKey: `vendor-ai-handoff-fwd:${args.messageSid}`, sendClass: "transactional",
      }, args.provider);
      forwarded = result.ok;
      if (!result.ok && !result.authorized) console.info("vendor number AI handoff forward skipped", result.reason);
    }
  }
  return { noted, forwarded };
}
