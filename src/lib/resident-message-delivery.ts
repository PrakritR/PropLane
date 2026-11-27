/**
 * What every message PropLane sends a resident is made of, decided in one pure place (client-safe, no server
 * imports). The senders (`deliverPortalInboxMessage`, `deliverPaymentReminder`) ask these helpers instead of each
 * re-deciding:
 *
 *  - **Three ways.** The resident portal inbox is always written (it is also the manager's Communication record),
 *    a text goes from the work number when the resident can be texted (consent and STOP are the senders' existing
 *    gates, unchanged), and an email goes through PropLane's own sending only to a real mailbox.
 *  - **No email on file = no email.** Blank, an import placeholder (`@import.proplane.local`), a phone-only login
 *    (`@phone.proplane.invalid`), a deleted tombstone (`@deleted.invalid`) or sheet junk is never handed to the
 *    mail provider; portal + text still go.
 *  - **No account yet = one setup line.** A resident PropLane knows but who has no PropLane account gets ONE short
 *    line at the end of every message with the open resident sign-up link. Never twice in one message, never for
 *    someone who already has an account.
 */
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { isPlaceholderMailbox } from "@/lib/inbox-delivery-status";

/** The words the account-setup line opens with; also how a body that already carries it is recognised. */
export const ACCOUNT_SETUP_REMINDER_LEAD = "Set up your PropLane account";

/** True when this address can receive an email: not blank and not a placeholder family. */
export function residentEmailDeliverable(email: string | null | undefined): boolean {
  return !isPlaceholderMailbox(email);
}

/** The sign-up link the reminder carries: the existing open resident sign-up (phone code or email). */
export function residentAccountSetupUrl(): string {
  return residentPortalUrl("create_account");
}

export function accountSetupReminderLine(url: string = residentAccountSetupUrl()): string {
  return `${ACCOUNT_SETUP_REMINDER_LEAD}: ${url}`;
}

/** The body already carries the line, or is itself an account-setup message (a setup or sign-up link). */
export function hasAccountSetupReminder(text: string | null | undefined): boolean {
  const body = String(text ?? "");
  return body.includes(ACCOUNT_SETUP_REMINDER_LEAD) || /\/auth\/(?:resident-setup|create-account)\b/.test(body);
}

/**
 * The message with the account-setup line at its end, for a resident with no account. A resident with an account,
 * an empty body, or a body that already ends with (or carries) the line comes back unchanged, so a retry or a
 * second pass through another sender never adds it twice.
 */
export function withAccountSetupReminder(text: string, opts: { hasAccount: boolean; url?: string }): string {
  if (opts.hasAccount) return text;
  const body = String(text ?? "").trimEnd();
  if (!body || hasAccountSetupReminder(body)) return text;
  return `${body}\n\n${accountSetupReminderLine(opts.url)}`;
}

export type ResidentMessageChannels = { portal: true; email: boolean; sms: boolean };

/**
 * The channels one resident message goes out on: the portal always; email only when the sender wants it AND the
 * address is a real mailbox; text exactly when the sender's own consent-checked decision says so (passed through,
 * never widened here).
 */
export function residentMessageChannels(input: {
  email: string | null | undefined;
  emailWanted: boolean;
  smsAllowed: boolean;
}): ResidentMessageChannels {
  return { portal: true, email: input.emailWanted && residentEmailDeliverable(input.email), sms: input.smsAllowed };
}
