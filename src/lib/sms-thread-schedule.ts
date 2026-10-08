/**
 * "Schedule for later" from a text conversation's composer.
 *
 * It rides the one existing scheduled-send path (`POST /api/portal/scheduled-inbox-messages`),
 * which keys a send on the recipient's EMAIL. A conversation known only by its phone number
 * therefore has no scheduling path yet: the control is withheld for it rather than offered and
 * refused. Pure so the rule is unit-testable.
 */

export type SmsThreadScheduleInput = {
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
export function smsThreadCanSchedule(residentEmail: string | null | undefined): boolean {
  return Boolean(residentEmail && residentEmail.trim().includes("@"));
}

export type SmsThreadScheduleResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

export function buildSmsThreadScheduleBody(input: SmsThreadScheduleInput): SmsThreadScheduleResult {
  const email = input.residentEmail?.trim().toLowerCase() ?? "";
  if (!smsThreadCanSchedule(email)) {
    return { ok: false, error: "Add an email to this contact to schedule a message." };
  }
  const text = input.text.trim();
  if (!text) return { ok: false, error: "Write a message to schedule." };
  if (!input.viaEmail && !input.viaSms) return { ok: false, error: "Choose Email, SMS, or both." };
  const sendAt = new Date(input.sendAtLocal);
  if (Number.isNaN(sendAt.getTime())) return { ok: false, error: "Choose a valid send date and time." };
  if (sendAt.getTime() < (input.nowMs ?? Date.now()) - 60_000) {
    return { ok: false, error: "Send time must be in the future." };
  }
  const name = input.residentName?.trim() || input.phone?.trim() || email;
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
