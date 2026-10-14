/**
 * "Schedule for later" from a text conversation's composer.
 *
 * It rides the one existing scheduled-send path (`POST /api/portal/scheduled-inbox-messages`),
 * which keys a send on the recipient's EMAIL. A conversation known only by its phone number
 * therefore has no scheduling path yet: the control is withheld for it rather than offered and
 * refused. Pure so the rule is unit-testable.
 */

import { normalizeE164 } from "@/lib/phone-e164";

export type SmsThreadScheduleInput = {
  conversationKey?: string | null;
  /** The conversation's saved email, if any. */
  residentEmail?: string | null;
  residentName?: string | null;
  phone?: string | null;
  text: string;
  viaEmail: boolean;
  viaSms: boolean;
  /** `datetime-local` value from the composer's schedule menu. */
  sendAtLocal: string;
  nowMs?: number;
};

/** True when a text conversation can be scheduled (the scheduler needs an email to key on). */
export function smsThreadCanSchedule(
  residentEmail: string | null | undefined,
  phone?: string | null,
): boolean {
  if (residentEmail && residentEmail.trim().includes("@")) return true;
  // A phone-only conversation schedules a Text keyed on its E.164 number.
  return normalizeE164(String(phone ?? "").trim()) !== null;
}

export type SmsThreadScheduleResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

export function buildSmsThreadScheduleBody(input: SmsThreadScheduleInput): SmsThreadScheduleResult {
  const email = input.residentEmail?.trim().toLowerCase() ?? "";
  const e164 = normalizeE164(String(input.phone ?? "").trim());
  const phoneOnly = !email.includes("@");
  if (phoneOnly && !e164) {
    return { ok: false, error: "Add an email or phone to this contact to schedule a message." };
  }
  const text = input.text.trim();
  if (!text) return { ok: false, error: "Write a message to schedule." };
  if (phoneOnly && !input.viaSms) return { ok: false, error: "This contact has no email. Choose Text." };
  if (!input.viaEmail && !input.viaSms) return { ok: false, error: "Choose Email, SMS, or both." };
  const sendAt = new Date(input.sendAtLocal);
  if (Number.isNaN(sendAt.getTime())) return { ok: false, error: "Choose a valid send date and time." };
  if (sendAt.getTime() < (input.nowMs ?? Date.now()) - 60_000) {
    return { ok: false, error: "Send time must be in the future." };
  }
  const name = input.residentName?.trim() || input.phone?.trim() || email;
  if (phoneOnly) {
    return {
      ok: true,
      body: {
        senderPortal: "manager",
        subject: `Message for ${name}`,
        body: text,
        sendAt: sendAt.toISOString(),
        recipientEmail: "",
        recipientPhone: e164,
        conversationKey: input.conversationKey ?? undefined,
        recipientName: name,
        deliverViaInbox: false,
        deliverViaEmail: false,
        deliverViaSms: true,
      },
    };
  }
  return {
    ok: true,
    body: {
      senderPortal: "manager",
      subject: `Message for ${name}`,
      body: text,
      sendAt: sendAt.toISOString(),
      recipientEmail: email,
      recipientName: name,
      // A text-only schedule must not also email or land in the portal inbox.
      deliverViaInbox: input.viaEmail,
      deliverViaEmail: input.viaEmail,
      deliverViaSms: input.viaSms,
    },
  };
}
