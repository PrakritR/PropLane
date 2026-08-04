import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendSms } from "@/lib/twilio";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

/**
 * Per-manager SMS proxy relay. Each manager has ONE PropLane-owned number that
 * carries BOTH legs of a resident conversation:
 *
 *   Leg 1 (resident → manager): a resident texts the PropLane number. The
 *   message is stored in the PropLane thread and forwarded as an SMS to the
 *   manager's own personal cell, labelled with WHO it is from — never the raw
 *   resident number, which the manager should not have.
 *
 *   Leg 2 (manager → resident): the manager replies by texting the SAME PropLane
 *   number from their cell. We match it to their active resident conversation
 *   (deterministic rule below), deliver it to the resident FROM the PropLane
 *   number (so the resident never sees the manager's real cell), and store it in
 *   the same thread.
 *
 * The number is the isolation boundary: the manager is whoever owns the work
 * number that was texted, so a message can never cross tenants.
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

export type ActiveConversation = {
  residentPhone: string;
  residentUserId: string | null;
  conversationKey: string | null;
  lastMessageAt: string | null;
};

/**
 * The manager's active resident conversation for reply-matching.
 *
 * DETERMINISTIC RULE: the resident conversation with the MOST RECENT message in
 * either direction (newest `created_at` across inbound + outbound). This is the
 * thread the manager just saw forwarded to their cell, so a bare reply lands
 * where a human would expect. Only resident-role threads are eligible so a reply
 * can never leak into a prospect/leasing thread.
 */
export async function resolveManagerActiveConversation(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ActiveConversation | null> {
  const id = managerUserId.trim();
  if (!id) return null;
  const { data } = await db
    .from("manager_sms_messages")
    .select("resident_phone, resident_user_id, conversation_key, counterparty_role, created_at")
    .eq("manager_user_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Array<{
    resident_phone: string | null;
    resident_user_id: string | null;
    conversation_key: string | null;
    counterparty_role: string | null;
    created_at: string | null;
  }>;
  for (const row of rows) {
    const role = String(row.counterparty_role ?? "").trim();
    // Resident threads only (an unset legacy role is treated as resident-eligible).
    if (role && role !== "resident") continue;
    const residentPhone = String(row.resident_phone ?? "").trim();
    if (!residentPhone) continue;
    return {
      residentPhone,
      residentUserId: row.resident_user_id ?? null,
      conversationKey: row.conversation_key ?? null,
      lastMessageAt: row.created_at ?? null,
    };
  }
  return null;
}

export type ManagerReplyResult =
  | {
      ok: true;
      residentPhone: string;
      /**
       * Whether the `manager_sms_messages` row landed. FALSE means the resident
       * received the text but the thread has no record of it — and because that
       * row is what `humanOwnsConversation` reads, the inbound router will keep
       * auto-replying over a conversation this manager has joined. The send is
       * still reported as `ok` because the text is already gone; a retry would
       * only text the resident twice.
       */
      logged: boolean;
    }
  | { ok: false; error: "no_active_conversation" | "registration_pending" | "send_failed" };

/**
 * Leg 2: deliver a manager's texted-back reply to their active resident
 * conversation, from the PropLane number, persisted in the same thread.
 *
 * Registration-gated: we resolve the manager's sendable number EXPLICITLY and
 * bail when it is null, rather than letting sendFromManagerWorkNumber fall back
 * to profiles.sms_from_number — otherwise an active-but-unapproved number would
 * still send, defeating "active yet unsendable until registration clears".
 */
export async function handleManagerReplyInbound(
  db: SupabaseClient,
  args: { managerUserId: string; workNumber: string; body: string },
): Promise<ManagerReplyResult> {
  const sendNumber = await resolveActiveManagerSendNumber(db, args.managerUserId);
  if (!sendNumber) return { ok: false, error: "registration_pending" };

  const active = await resolveManagerActiveConversation(db, args.managerUserId);
  if (!active) return { ok: false, error: "no_active_conversation" };

  const sent = await sendFromManagerWorkNumber({
    managerUserId: args.managerUserId,
    to: active.residentPhone,
    text: args.body,
    fromNumber: sendNumber,
    residentUserId: active.residentUserId,
    source: "work_number",
    counterpartyRole: "resident",
  });
  if (!sent.ok) return { ok: false, error: "send_failed" };
  if (sent.logged === false) {
    console.error("manager relay reply sent but manager_sms_messages row did not land", {
      managerUserId: args.managerUserId,
      source: "work_number",
    });
  }
  return { ok: true, residentPhone: active.residentPhone, logged: sent.logged !== false };
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
  args: { managerUserId: string; workNumber: string; fromPhone: string; body: string },
): Promise<boolean> {
  // Registration gate: never send FROM a number whose registration is not
  // approved (the same rule as the reply leg).
  const sendNumber = await resolveActiveManagerSendNumber(db, args.managerUserId);
  if (!sendNumber) return false;

  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at")
    .eq("id", args.managerUserId)
    .maybeSingle();
  const managerCell = String(data?.phone ?? "").trim();
  if (!managerCell || !data?.phone_verified_at) return false;

  const label = await senderLabelForInbound(db, { managerUserId: args.managerUserId, fromPhone: args.fromPhone });
  const text = `${label}: ${args.body}\n\n(Reply to this text to respond — PropLane keeps your number private.)`;
  // Honor the manager's own opt-out: a manager who texted STOP to their work
  // number stops receiving forwards (carrier STOP applies to the number pair).
  const res = await sendSms(managerCell, text, sendNumber);
  return res.sent;
}
