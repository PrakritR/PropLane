import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";
import { isNumberSubscriptionEnabled } from "@/lib/number-subscription/constants";
import { finishNumberCredit, reserveNumberCredit } from "@/lib/number-subscription/credit.server";
import { loadVendorVerifiedPhone } from "@/lib/vendor-work-identity.server";
import {
  createVendorWorkIdentityDeliveryProvider,
  type VendorDeliveryProvider,
} from "@/lib/vendor-work-identity-delivery.server";
import { runResidentPersonalAgentReply } from "@/lib/agent/resident-personal-agent.server";
import { findActiveResidentAgentNumberByPhone, type ResidentAgentNumber } from "./number.server";

export type ResidentAgentInboundResult = { handled: boolean; idempotent?: boolean; afterResponse?: () => Promise<void> };

/**
 * An inbound text to a resident's PropLane number (called by `/api/twilio/inbound` after STOP/START/HELP,
 * next to the vendor-number branch). Off while `NUMBER_SUBSCRIPTION_ENABLED` is off: no lookup, no
 * routing change. The number's owner is whoever our table says owns the texted number.
 *
 * - From the owner's own VERIFIED phone: the text is a command to their agent. The turn runs after
 *   Twilio has its response (`afterResponse`).
 * - From anyone else (a manager's line, a stranger): it only lands in the owner's PropLane inbox. No AI
 *   ever answers a third party on a resident's number.
 */
export async function ingestResidentAgentNumberSms(
  db: SupabaseClient,
  input: { toPhone: string; fromPhone: string; text: string; messageSid: string },
  deps: { provider?: VendorDeliveryProvider; now?: Date; findNumber?: typeof findActiveResidentAgentNumberByPhone } = {},
): Promise<ResidentAgentInboundResult> {
  if (!isNumberSubscriptionEnabled()) return { handled: false };
  const to = normalizeE164(input.toPhone);
  const from = normalizeE164(input.fromPhone);
  if (!to || !from || !input.messageSid) return { handled: false };
  const number = await (deps.findNumber ?? findActiveResidentAgentNumberByPhone)(db, to);
  if (!number) return { handled: false };

  const verified = await loadVendorVerifiedPhone(db, number.residentUserId);
  if (verified.verified && verified.phone === from) {
    const provider = deps.provider ?? createVendorWorkIdentityDeliveryProvider();
    const afterResponse = async () => {
      try {
        await runResidentPersonalAgentReply(db, { number, from, text: input.text, messageSid: input.messageSid, now: deps.now }, { provider });
      } catch (error) {
        console.error("resident agent reply failed", input.messageSid, error instanceof Error ? error.message : error);
      }
    };
    return { handled: true, afterResponse };
  }
  return storeThirdPartyText(db, number, { from, text: input.text, messageSid: input.messageSid }, deps.now);
}

async function storeThirdPartyText(
  db: SupabaseClient,
  number: ResidentAgentNumber,
  input: { from: string; text: string; messageSid: string },
  now?: Date,
): Promise<ResidentAgentInboundResult> {
  const body = input.text.trim() || "(text received)";
  const stored = await deliverPortalMessageThreadSide(db, {
    scope: scopeForRole("resident"),
    folder: "inbox",
    ownerUserId: number.residentUserId,
    participantEmail: `${input.from}@sms.proplane.local`,
    otherPartyEmail: `${input.from}@sms.proplane.local`,
    // The texter is a phone, not an address: the conversation is keyed by the number.
    conversation: { otherPartyPhone: input.from },
    fallbackId: `resident-agent-inbound-sms:${number.residentUserId}:${input.from}`,
    fromName: input.from,
    subject: "Text message",
    body,
    preview: body.slice(0, 100).replace(/\n/g, " "),
    when: formatPacificDateTime(now ?? new Date()),
    unread: true,
    outbound: false,
    messageId: `resident-agent-inbound-sms:${input.messageSid}`,
    channel: "sms",
    messageSubject: "Text message",
  });
  const duplicate = stored.action === "skipped";
  if (!duplicate) {
    // A received text is an unavoidable cost: debit what the balance holds, the platform absorbs the rest.
    const key = `rpa-in:${input.messageSid}`;
    try {
      await reserveNumberCredit(number.residentUserId, "sms_inbound_segment", Math.max(1, estimateSmsSegments(body).segmentCount), key, {
        db,
        allowUnfunded: true,
      });
      await finishNumberCredit(number.residentUserId, key, { db });
    } catch (error) {
      console.warn("resident agent inbound credit not recorded", error instanceof Error ? error.message : error);
    }
  }
  return { handled: true, idempotent: duplicate };
}
