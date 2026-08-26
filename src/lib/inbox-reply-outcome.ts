/**
 * The result of a multi-channel inbox reply. These booleans describe what the
 * server actually accepted, never merely what the sender selected in the UI.
 */
export type InboxReplySendOutcome = {
  emailRequested: boolean;
  smsRequested: boolean;
  emailOk: boolean;
  smsOk: boolean;
  /** Provider submission may have happened, so retrying is unsafe. */
  smsUnknown?: boolean;
};

/** A server refusal whose message is safe and useful to show to the sender. */
export class InboxSendRefusal extends Error {
  readonly reason: string | null;

  constructor(reason: string | null) {
    super(reason ?? "inbox send refused");
    this.name = "InboxSendRefusal";
    this.reason = reason;
  }
}

/** Build success copy from actual channel outcomes, including partial sends. */
export function inboxReplySentToastMessage(
  outcome: InboxReplySendOutcome,
): string {
  const emailDelivered = outcome.emailRequested && outcome.emailOk;
  const smsDelivered = outcome.smsRequested && outcome.smsOk;
  if (outcome.smsUnknown) {
    return emailDelivered
      ? "Email sent. Text delivery could not be confirmed—do not resend it; check the conversation later."
      : "Text delivery could not be confirmed—do not resend it; check the conversation later.";
  }
  if (!emailDelivered && !smsDelivered) return "Could not send reply.";

  const emailFailed = outcome.emailRequested && !outcome.emailOk;
  const smsFailed = outcome.smsRequested && !outcome.smsOk;
  if (smsFailed) return "Reply sent via email. Text message failed.";
  if (emailFailed) return "Reply sent via text. Email failed.";
  if (emailDelivered && smsDelivered) return "Reply sent via email and text.";
  if (smsDelivered) return "Reply sent via text.";
  return "Reply sent.";
}
