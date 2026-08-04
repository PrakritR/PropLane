/**
 * Inbound-SMS intent router — the seam between the messaging transport and the
 * public listing entry points ("Text to tour", "Text to apply").
 *
 * OWNERSHIP: the axis-sms-text-to-entry lane owns this file's BODY. The
 * transport (axis-sms-two-way-spine) owns the call site in
 * `/api/twilio/inbound`, which resolves the sender + conversation, persists the
 * message, and then calls {@link routeInboundSms} with the resolved context.
 *
 * Contract:
 * - `handled: false` (this stub) → the transport falls through to the default
 *   inbound handling (leasing bot / resident hub) unchanged.
 * - `handled: true` → the router produced the reply; the transport sends
 *   `autoReplyBody` (when present) back to the texter from the number that was
 *   texted, logs both directions into the conversation, fans out the manager
 *   notifications, and SKIPS default handling.
 *
 * Do not add transport concerns here (persistence, forwarding, consent) — the
 * call site owns those on both branches. Implement intent/keyword matching and
 * tour/application creation only.
 */
export type InboundSmsContext = {
  fromPhone: string;
  toPhone: string; // the manager number that was texted
  body: string;
  managerId: string;
  conversationId: string;
  isFirstMessageInConversation: boolean;
};

export type SmsIntentResult = {
  handled: boolean; // true = the router produced the reply; skip default handling
  autoReplyBody?: string; // the automated response to send back, if any
};

export async function routeInboundSms(ctx: InboundSmsContext): Promise<SmsIntentResult> {
  void ctx;
  return { handled: false };
}
