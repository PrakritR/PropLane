import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { readScopedSmsConsentState, recordScopedSmsConsent } from "@/lib/sms-consent";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

/** Consent + outbox scope for manager-cell mirrors, distinct from resident traffic. */
const MANAGER_FORWARD_PURPOSE = "manager_inbound_forward";

/** One stable thread identity per manager for their own mirror copies. */
function managerForwardConversationKey(managerUserId: string): string {
  return `${managerUserId}:manager:${managerUserId}`;
}

/**
 * Per-manager SMS identity helpers. Each manager has ONE PropLane-owned work
 * number, and the number is the isolation boundary: the manager is whoever owns
 * the number that was texted, so a message can never cross tenants.
 *
 * `detectManagerSelfReply` is the identity gate for the MANAGER AGENT
 * (`src/lib/agent/manager-sms-agent.server.ts`) — a manager texting their own
 * work number from their verified cell gets the assistant.
 *
 * The old blind Leg 2 relay lived here and is gone. It forwarded whatever the
 * manager typed to their most-recently-active resident thread, chosen by
 * recency alone. Leg 1 below mirrors a resident text to their cell, but a bare
 * reply still could not say WHICH thread it meant — with two conversations
 * moving, "on my way" went to whoever wrote last. Reaching a resident is now an
 * explicit, named proposal the manager confirms.
 */

/** Last-10-digits comparison so `+1XXXXXXXXXX`, `1XXXXXXXXXX`, `(XXX) …` all match. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = String(a ?? "").replace(/\D/g, "");
  const db = String(b ?? "").replace(/\D/g, "");
  if (!da || !db) return false;
  const na = da.length === 11 && da.startsWith("1") ? da.slice(1) : da;
  const nb = db.length === 11 && db.startsWith("1") ? db.slice(1) : db;
  return na.length >= 10 && nb.length >= 10 && na.slice(-10) === nb.slice(-10);
}

/** Masked handle for a phone we must not reveal in full: `Texter ····1234`. */
export function maskedTexterLabel(phone: string): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  const last4 = d.slice(-4);
  return last4 ? `Texter ····${last4}` : "a resident";
}

export type ManagerSelfReply = { managerUserId: string; workNumber: string; managerPhone: string };

/**
 * When the inbound `From` is a manager's OWN verified personal cell and `To` is
 * that same manager's work number, this is a manager reply, not a new inbound
 * from a resident. Returns the manager identity, else null. The work number pins
 * the manager first, so the verified-phone check is scoped to that one manager.
 */
export async function detectManagerSelfReply(
  db: SupabaseClient,
  args: { managerUserId: string; fromPhone: string; toPhone: string },
): Promise<ManagerSelfReply | null> {
  const managerUserId = args.managerUserId.trim();
  if (!managerUserId) return null;
  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at, sms_from_number")
    .eq("id", managerUserId)
    .maybeSingle();
  const managerPhone = String(data?.phone ?? "").trim();
  const verified = !!data?.phone_verified_at;
  if (!managerPhone || !verified) return null;
  if (!samePhone(managerPhone, args.fromPhone)) return null;
  const workNumber = normalizeE164(args.toPhone) ?? args.toPhone;
  return { managerUserId, workNumber, managerPhone };
}

/**
 * A human-readable label for who a resident inbound is from, for the manager
 * forward. Prefers the resident's stored name; falls back to a masked handle.
 * NEVER returns the raw resident phone number.
 */
export async function senderLabelForInbound(
  db: SupabaseClient,
  args: { managerUserId: string; fromPhone: string },
): Promise<string> {
  // resident_phone is stored E.164 (phoneKey → normalizeE164) at write time, so
  // match with the SAME normalization or the name lookup never hits.
  const phoneMatch = normalizeE164(args.fromPhone) ?? String(args.fromPhone).trim();
  const { data } = await db
    .from("manager_sms_messages")
    .select("resident_user_id")
    .eq("manager_user_id", args.managerUserId)
    .eq("resident_phone", phoneMatch)
    .not("resident_user_id", "is", null)
    .limit(1);
  const residentUserId = String((data ?? [])[0]?.resident_user_id ?? "").trim();
  if (residentUserId) {
    const { data: prof } = await db
      .from("profiles")
      .select("full_name")
      .eq("id", residentUserId)
      .maybeSingle();
    const name = String(prof?.full_name ?? "").trim();
    if (name) return name;
  }
  return maskedTexterLabel(args.fromPhone);
}

/**
 * Leg 1: forward a resident's inbound text to the manager's own verified cell,
 * FROM the PropLane number, labelled with the sender. No-op (returns false) when
 * the manager has no verified cell or Twilio isn't configured — the message is
 * still stored in the thread by the caller regardless.
 */
export async function forwardResidentInboundToManagerCell(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    workNumber: string;
    fromPhone: string;
    body: string;
    /** Twilio's inbound MessageSid — pins the dedupe key so a webhook retry
     * cannot text the manager the same message twice. */
    messageSid?: string | null;
    /** The texter's capacity. Decides whether the mirror may invite a reply:
     * Leg 2 routes a manager's texted-back reply to their newest RESIDENT
     * thread and deliberately skips prospect threads, so inviting a reply to a
     * prospect's mirror would hand that reply to an unrelated resident. */
    counterpartyRole?: "resident" | "prospect";
  },
): Promise<boolean> {
  const managerUserId = args.managerUserId.trim();
  if (!managerUserId) return false;

  const { data, error } = await db
    .from("profiles")
    .select("phone, phone_verified_at, sms_forward_inbound")
    .eq("id", managerUserId)
    .maybeSingle();
  // Fail closed: an unreadable profile is not permission to text a cell.
  if (error) return false;
  // The forward goes to the manager's OWN number, so it is only ever sent to a
  // number that account proved it controls via the verification code. An
  // unverified `profiles.phone` is user-editable free text and could name a
  // stranger's cell, which is why verification — not presence — is the gate.
  if (!data?.phone_verified_at) return false;
  // Opt-out lives on the manager's own profile (Settings → Messaging).
  if (data.sms_forward_inbound === false) return false;
  const managerPhone = normalizeE164(String(data.phone ?? "").trim());
  if (!managerPhone) return false;
  // A manager texting their own work number is Leg 2, already handled upstream;
  // forwarding it back would text them their own words.
  if (samePhone(managerPhone, args.fromPhone)) return false;

  const sendNumber = await resolveActiveManagerSendNumber(db, managerUserId);
  if (!sendNumber) return false;

  // Scoped consent for a DIFFERENT purpose than resident traffic, so a manager
  // who stops the forwards keeps their outbound conversation rails. The grant
  // is materialized from their own phone verification, and — exactly like the
  // rental-application grant — a prior revoke on this scope always wins over
  // re-materializing it here.
  const scope = {
    managerUserId,
    purpose: MANAGER_FORWARD_PURPOSE,
    sendClass: "transactional" as const,
    conversationKey: managerForwardConversationKey(managerUserId),
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null,
  };
  const consent = await readScopedSmsConsentState(db, managerPhone, scope);
  if (!consent.ok || consent.state === "revoked") return false;
  if (consent.state === "none") {
    const granted = await recordScopedSmsConsent(db, managerPhone, {
      ...scope,
      eventType: "granted",
      source: "manager_phone_verification",
      occurredAt: String(data.phone_verified_at),
      evidence: { managerUserId },
    });
    if (!granted.ok) return false;
  }

  const label = await senderLabelForInbound(db, {
    managerUserId,
    fromPhone: args.fromPhone,
  });
  const replyHint =
    args.counterpartyRole === "resident"
      ? "Reply to this text to answer them."
      : "Reply in PropLane to answer them.";
  const text = `${label}: ${args.body.trim() || "(no text)"}\n\n${replyHint}`;

  const sent = await sendFromManagerWorkNumber({
    managerUserId,
    to: managerPhone,
    text,
    fromNumber: sendNumber,
    source: "work_number",
    counterpartyRole: "manager",
    conversationKey: scope.conversationKey,
    purpose: MANAGER_FORWARD_PURPOSE,
    dedupeKey: args.messageSid?.trim() ? `manager_forward_${args.messageSid.trim()}` : null,
    // The resident's own words are already stored in their thread by the
    // inbound path. Logging this copy too would render the manager's mirror as
    // an outbound message to the resident that they never received.
    skipLog: true,
  });
  return sent.ok;
}
