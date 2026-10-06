import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { MANAGER_CONVERSATION_WINS_DAYS, managerTextedPhoneWithin } from "@/lib/sms/inbound-text-routing.server";
import { recordVendorInboundReplyConsent } from "@/lib/sms/vendor-conversation-consent.server";

type RunTurn = (
  db: SupabaseClient,
  session: never,
  text: string,
  channel: "sms",
  options: { inboundMessageSid: string; precomputedReply: string | null; reference: unknown },
) => Promise<unknown>;

/**
 * A text from a vendor who has a job session with this manager. The manager's own
 * conversation wins (Decide #3, Oct 6): when this manager texted the vendor in the
 * last 7 days the text lands in that thread (the caller already projected it) and
 * the job assistant does NOT answer over it; the vendor's text also unlocks the
 * manager's reply. Otherwise the job assistant answers, as it always has.
 */
export async function handleVendorSessionInbound(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    phoneE164: string;
    messageSid: string;
    body: string;
    vendor:
      | { kind: "session"; session: { vendor_user_id?: string | null }; reference: unknown }
      | { kind: "reply"; session: { vendor_user_id?: string | null }; reply: string };
    runTurn: RunTurn;
    now?: Date;
  },
): Promise<{ route: "manager_thread" | "job_assistant" }> {
  const recent = await managerTextedPhoneWithin(db, {
    managerUserId: input.managerUserId,
    phoneE164: input.phoneE164,
    days: MANAGER_CONVERSATION_WINS_DAYS,
    now: input.now,
  });
  if (recent.texted) {
    await recordVendorInboundReplyConsent(db, {
      managerUserId: input.managerUserId,
      vendorUserId: input.vendor.session.vendor_user_id ?? null,
      phone: input.phoneE164,
      messageSid: input.messageSid,
    }).catch(() => "unavailable" as const);
    return { route: "manager_thread" };
  }
  await input.runTurn(db, input.vendor.session as never, input.body, "sms", {
    inboundMessageSid: input.messageSid,
    precomputedReply: input.vendor.kind === "reply" ? input.vendor.reply : null,
    reference: input.vendor.kind === "session" ? input.vendor.reference : null,
  });
  return { route: "job_assistant" };
}
