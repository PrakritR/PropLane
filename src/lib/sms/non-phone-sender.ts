/**
 * A text whose `From` is not a phone number: a carrier SHORT CODE (3-8 digits: verification codes, alerts) or an
 * ALPHANUMERIC sender id ("ROOMIES"). `normalizeE164` rejects both on purpose, which is why the inbound webhook used to
 * answer them 400 and store nothing. They are real inbound mail for PropLane (the captain's own sign-up codes arrive this
 * way), so they are stored as their own conversation and announced to PropLane's admin phones.
 *
 * Hard rule, pure and tested: a non-phone sender is NEVER replied to and never reaches an agent. Carriers reject a reply to
 * a short code and each attempt costs credit. STOP / HELP are not interpreted for them either: a "STOP" from 78156 is the
 * sender's own text, not a subscriber opting out. Pure: no database.
 */
import { normalizeE164 } from "@/lib/phone-e164";

export type NonPhoneSenderKind = "short_code" | "alphanumeric";
export type NonPhoneSender = { kind: NonPhoneSenderKind; sender: string };

/** Twilio documents alphanumeric sender ids as up to 11 characters (letters, digits, space, a few marks). */
const ALPHANUMERIC = /^(?=.*[A-Za-z])[A-Za-z0-9 ._&-]{1,11}$/;
const SHORT_CODE = /^\d{3,8}$/;

/** Null for a real phone number (it takes the ordinary path) or for anything that is neither shape (it stays refused). */
export function classifyNonPhoneSender(from: unknown): NonPhoneSender | null {
  const raw = typeof from === "string" ? from.trim() : "";
  if (!raw || normalizeE164(raw)) return null;
  if (SHORT_CODE.test(raw)) return { kind: "short_code", sender: raw };
  if (ALPHANUMERIC.test(raw)) return { kind: "alphanumeric", sender: raw };
  return null;
}

/** The stable conversation key for one non-phone sender on one line owner. */
export function nonPhoneConversationKey(ownerUserId: string, sender: string): string {
  return `${ownerUserId.trim()}:unknown:sender:${sender.trim().toLowerCase()}`;
}

export const NON_PHONE_ALERT_MAX_CHARS = 320;

/** The one line PropLane's admin phones get: who, and the body IN FULL (a verification code is the whole point). */
export function buildNonPhoneAlertText(sender: string, body: string): string {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  const head = `PropLane text from ${sender}: `;
  const room = NON_PHONE_ALERT_MAX_CHARS - head.length;
  const text = flat.length > room ? `${flat.slice(0, Math.max(0, room - 3)).trimEnd()}...` : flat;
  return `${head}${text || "(no text)"}`;
}
