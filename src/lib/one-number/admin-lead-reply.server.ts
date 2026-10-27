import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPlatformLeadText, type PlatformLeadSendResult } from "@/lib/one-number/lead-send.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { e164FromPhoneKey, recordReply } from "@/lib/one-number/unassigned-leads.server";

export const ADMIN_LEAD_REPLY_MAX_LENGTH = 1600;

export type AdminLeadReplyResult =
  | { ok: true; sid: string }
  | { ok: false; status: 400 | 404 | 409 | 422 | 502 | 503; error: string };

const REFUSAL: Record<Exclude<PlatformLeadSendResult, { ok: true }>["reason"], { status: 409 | 422 | 502 | 503; error: string }> = {
  opted_out: { status: 409, error: "That number has opted out of texts." },
  shielded: { status: 409, error: "That number cannot be texted." },
  quiet_hours: { status: 409, error: "Texts to this number are paused until morning." },
  invalid_to: { status: 422, error: "That lead has no valid phone number." },
  not_shared_mode: { status: 503, error: "The PropLane line is not available." },
  no_shared_number: { status: 503, error: "The PropLane line is not available." },
  provider_error: { status: 502, error: "Could not send SMS." },
  delivery_unknown: { status: 502, error: "The text may not have been delivered. Check before sending again." },
};

/**
 * Admin answers an Unassigned lead from the PropLane line (the 206), in the lead's thread. The lead's number is resolved
 * HERE from the lead id (the browser only ever holds the masked number), and the send is the platform-lead transport:
 * the opt-out ledger, recipient shield and test capture apply exactly as for the lead agent's own texts. The caller has
 * already proved the viewer is a platform admin; a body id is a name, never a grant.
 *
 * The text is recorded in the lead thread only after the transport accepted it (authorize, send, then append).
 */
export async function sendAdminLeadReply(
  db: SupabaseClient,
  input: { leadId: string; text: string },
  deps: { send?: typeof sendPlatformLeadText } = {},
): Promise<AdminLeadReplyResult> {
  const text = toGsm7(String(input.text ?? "").trim());
  if (!text) return { ok: false, status: 400, error: "Enter a message." };
  if (text.length > ADMIN_LEAD_REPLY_MAX_LENGTH) {
    return { ok: false, status: 400, error: `Message is too long (max ${ADMIN_LEAD_REPLY_MAX_LENGTH} characters).` };
  }
  const { data, error } = await db
    .from("sms_unassigned_leads")
    .select("id, phone_key, status")
    .eq("id", input.leadId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: "Could not read this lead." };
  const row = data as { phone_key?: unknown; status?: unknown } | null;
  const phoneKey = String(row?.phone_key ?? "").trim();
  if (!row || !phoneKey) return { ok: false, status: 404, error: "Lead not found." };
  if (String(row.status ?? "") !== "open") return { ok: false, status: 409, error: "Lead is not open." };

  const send = deps.send ?? sendPlatformLeadText;
  // A person is answering a person: transactional, so it is not held by the automated-outreach quiet hours.
  const result = await send(db, { to: e164FromPhoneKey(phoneKey), body: text, inboundReply: true });
  if (!result.ok) return { ok: false, ...REFUSAL[result.reason] };
  await recordReply(db, input.leadId, `admin:${result.sid}`, text, []);
  return { ok: true, sid: result.sid };
}
