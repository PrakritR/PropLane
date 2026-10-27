import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPlatformLeadText, type PlatformLeadSendResult } from "@/lib/one-number/lead-send.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { e164FromPhoneKey, recordReply } from "@/lib/one-number/unassigned-leads.server";

export const ADMIN_LEAD_REPLY_MAX_LENGTH = 1600;

export type AdminLeadReplyResult =
  | { ok: true; sid: string }
  | { ok: false; status: 400 | 404 | 409 | 422 | 502 | 503; error: string; /** The text went out; only the thread copy is missing. */ sent?: true };

/** A lead who texted within this window is being ANSWERED; older than that, an admin text is outreach and keeps quiet hours. */
export const ADMIN_LEAD_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ADMIN_LEAD_REPLY_NOT_SAVED_ERROR = "Sent, but not saved to the thread.";

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
  input: { leadId: string; text: string; /** The signed-in platform admin, from the session. */ adminUserId?: string; now?: Date },
  deps: { send?: typeof sendPlatformLeadText } = {},
): Promise<AdminLeadReplyResult> {
  const text = toGsm7(String(input.text ?? "").trim());
  if (!text) return { ok: false, status: 400, error: "Enter a message." };
  if (text.length > ADMIN_LEAD_REPLY_MAX_LENGTH) {
    return { ok: false, status: 400, error: `Message is too long (max ${ADMIN_LEAD_REPLY_MAX_LENGTH} characters).` };
  }
  const { data, error } = await db
    .from("sms_unassigned_leads")
    .select("id, phone_key, status, last_inbound_at")
    .eq("id", input.leadId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: "Could not read this lead." };
  const row = data as { phone_key?: unknown; status?: unknown; last_inbound_at?: unknown } | null;
  const phoneKey = String(row?.phone_key ?? "").trim();
  if (!row || !phoneKey) return { ok: false, status: 404, error: "Lead not found." };
  if (String(row.status ?? "") !== "open") return { ok: false, status: 409, error: "Lead is not open." };

  const send = deps.send ?? sendPlatformLeadText;
  // A person answering a person is transactional (not held by the automated-outreach quiet hours) only while the lead's
  // last inbound text is recent; a lead who has been silent longer is being texted first, which keeps quiet hours.
  const now = input.now ?? new Date();
  const lastInbound = Date.parse(String(row.last_inbound_at ?? ""));
  const inboundReply = Number.isFinite(lastInbound) && now.getTime() - lastInbound >= 0 && now.getTime() - lastInbound <= ADMIN_LEAD_REPLY_WINDOW_MS;
  const result = await send(db, { to: e164FromPhoneKey(phoneKey), body: text, inboundReply, now });
  if (!result.ok) return { ok: false, ...REFUSAL[result.reason] };
  const saved = await recordReply(db, input.leadId, `admin:${result.sid}`, text, [], input.adminUserId ? { sentByUserId: input.adminUserId } : {});
  if (!saved.ok) return { ok: false, status: 502, error: ADMIN_LEAD_REPLY_NOT_SAVED_ERROR, sent: true };
  return { ok: true, sid: result.sid };
}
