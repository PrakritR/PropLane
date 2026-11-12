/**
 * Delivery status of one inbox message, per channel. Pure and client-safe: the server writers
 * (`inbox-delivery-status.server.ts`) and the bubble / list / filter readers share these rules.
 * See docs/agents/communication-inbox.md § Delivery status.
 */

export type InboxDeliveryChannel = "sms" | "email";
export type InboxDeliveryState = "sending" | "sent" | "delivered" | "failed";

export type InboxMessageDelivery = {
  channel: InboxDeliveryChannel;
  /** Twilio MessageSid or Resend email id. Absent when the provider never accepted the message. */
  providerId?: string;
  status: InboxDeliveryState;
  /** One plain sentence, only on `failed`. */
  error?: string;
  /** ISO time of the last change. */
  at: string;
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Sandbox seed accounts: mail is skipped on purpose, which is not a failed delivery. */
export function isSandboxEmail(email: string | null | undefined): boolean {
  const to = String(email ?? "").trim().toLowerCase();
  return to.endsWith("@axis.local") || to.endsWith("@test.proplane.local");
}

/**
 * An address with no mailbox behind it: an import placeholder (`@import.proplane.local`), a PropLane-minted
 * stand-in (a Facebook lead's thread key), sheet junk, or no address at all. Mirrors
 * `isPlaceholderResidentEmail` (resident-welcome.server.ts) without its server imports.
 */
export function isPlaceholderMailbox(email: string | null | undefined): boolean {
  const to = String(email ?? "").trim().toLowerCase();
  if (!to) return true;
  if (to.endsWith("@import.proplane.local") || to.endsWith("@facebook.proplane.local")) return true;
  if (isSandboxEmail(to)) return true;
  if (/[()<>]/.test(to)) return true;
  return !EMAIL_SHAPE.test(to);
}

export const NOT_A_REAL_MAILBOX = "Not a real mailbox";
export const EMAIL_BOUNCED = "Email bounced";
export const EMAIL_MARKED_SPAM = "Marked as spam";
export const CARRIER_COULD_NOT_DELIVER = "Carrier couldn't deliver it";

const TWILIO_ERROR_TEXT: Readonly<Record<string, string>> = {
  "30003": "Phone was unreachable",
  "30004": "Message was blocked",
  "30005": "Number doesn't exist or is inactive",
  "30006": "Number can't receive texts (landline or unreachable carrier)",
  "30007": "Carrier filtered it as spam",
  "30008": "Carrier couldn't deliver it, reason unknown",
  "21610": "They opted out of texts (replied STOP)",
};

/** A plain-English line for a Twilio error code; unknown or absent codes get the generic sentence. */
export function twilioErrorMessage(errorCode: string | number | null | undefined): string {
  const code = String(errorCode ?? "").trim();
  return TWILIO_ERROR_TEXT[code] ?? CARRIER_COULD_NOT_DELIVER;
}

/** Twilio's message statuses folded onto the four the inbox shows. */
export function mapTwilioStatus(
  status: string | null | undefined,
  errorCode?: string | number | null,
): { status: InboxDeliveryState; error?: string } | null {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "queued" || s === "accepted" || s === "scheduled" || s === "sending") return { status: "sending" };
  if (s === "sent") return { status: "sent" };
  if (s === "delivered" || s === "read") return { status: "delivered" };
  if (s === "failed" || s === "undelivered" || s === "canceled") {
    return { status: "failed", error: twilioErrorMessage(errorCode) };
  }
  return null;
}

/** Resend webhook events folded onto the same states. `email.delivery_delayed` (and anything else) changes nothing. */
export function mapResendEvent(type: string | null | undefined): { status: InboxDeliveryState; error?: string } | null {
  switch (String(type ?? "").trim()) {
    case "email.delivered":
      return { status: "delivered" };
    case "email.bounced":
      return { status: "failed", error: EMAIL_BOUNCED };
    case "email.complained":
      return { status: "failed", error: EMAIL_MARKED_SPAM };
    default:
      return null;
  }
}

const RANK: Readonly<Record<InboxDeliveryState, number>> = { sending: 0, sent: 1, delivered: 2, failed: 2 };

/**
 * Merge one observation into a message's deliveries. Keyed on (channel, providerId); an entry with no
 * provider id is keyed on the channel alone. A callback may only advance: a terminal outcome
 * (delivered / failed) is never replaced by a different one, and a late "sent" never undoes "delivered".
 * Idempotent: the same observation twice yields an identical list.
 *
 * One exception: a `failed` entry with NO provider id is a send the provider never took, so a later
 * attempt on that channel (a retry of the same send) replaces it with its own outcome. Anything the
 * provider accepted keeps its terminal outcome, which is what makes out-of-order callbacks safe.
 */
export function mergeDelivery(
  existing: readonly InboxMessageDelivery[] | undefined,
  next: InboxMessageDelivery,
): InboxMessageDelivery[] {
  const list = [...(existing ?? [])];
  const index = list.findIndex(
    (d) =>
      d.channel === next.channel &&
      (next.providerId ? d.providerId === next.providerId || !d.providerId : !d.providerId),
  );
  if (index < 0) return [...list, next];
  const current = list[index]!;
  if (
    next.status === current.status &&
    (next.error ?? undefined) === (current.error ?? undefined) &&
    (!next.providerId || next.providerId === current.providerId)
  ) {
    return existing as InboxMessageDelivery[];
  }
  const retryOverUnsentFailure =
    current.status === "failed" && !current.providerId && next.status !== "failed";
  if (!retryOverUnsentFailure) {
    if (RANK[next.status] < RANK[current.status]) return existing as InboxMessageDelivery[];
    if (RANK[current.status] === 2 && current.status !== next.status) return existing as InboxMessageDelivery[];
  }
  const merged: InboxMessageDelivery = {
    ...current,
    ...next,
    providerId: next.providerId ?? current.providerId,
    ...(next.status === "failed" ? { error: next.error ?? current.error } : {}),
  };
  if (next.status !== "failed") delete merged.error;
  list[index] = merged;
  return list;
}

/**
 * Does a recorded delivery mean a retry of the SAME send (one `sendId`, one `messageId`) must skip
 * this channel? Only an attempt the provider took. A `failed` entry never reached the recipient, so
 * the retry is its second chance — otherwise a channel that failed once could never be re-attempted,
 * and the retry would just re-report the old failure.
 */
export function deliveryBlocksResend(delivery: Pick<InboxMessageDelivery, "status">): boolean {
  return delivery.status !== "failed";
}

/** A placeholder import address is recorded as failed at send time; nothing is ever handed to Resend. */
export function placeholderEmailDelivery(at: string): InboxMessageDelivery {
  return { channel: "email", status: "failed", error: NOT_A_REAL_MAILBOX, at };
}

export function failedDeliveries(deliveries: readonly InboxMessageDelivery[] | undefined): InboxMessageDelivery[] {
  return (deliveries ?? []).filter((d) => d.status === "failed");
}

/**
 * The message's overall state: it counts as failed only when EVERY channel it went on failed (a text that
 * landed beside a bounced email is delivered). Undefined when it carries no deliveries.
 */
export function overallDeliveryState(
  deliveries: readonly InboxMessageDelivery[] | undefined,
): InboxDeliveryState | undefined {
  if (!deliveries?.length) return undefined;
  if (deliveries.some((d) => d.status === "delivered")) return "delivered";
  if (deliveries.every((d) => d.status === "failed")) return "failed";
  if (deliveries.some((d) => d.status === "sent")) return "sent";
  if (deliveries.some((d) => d.status === "sending")) return "sending";
  return "failed";
}

/** Visible label of one channel's state under a bubble. */
export function deliveryStateLabel(delivery: Pick<InboxMessageDelivery, "channel" | "status">): string {
  if (delivery.status === "delivered") return "Delivered";
  if (delivery.status === "failed") return delivery.channel === "email" ? "Not delivered" : "Failed";
  if (delivery.status === "sending") return "Sending…";
  return "Sent";
}

type ThreadLike = {
  folder?: string;
  /** The prospect spine's thread-level issue (an inbound that could not be saved, a reply that was refused). */
  deliveryIssue?: unknown;
  rootOutbound?: boolean;
  rootDeliveries?: InboxMessageDelivery[];
  messages?: { outbound?: boolean; deliveries?: InboxMessageDelivery[] }[];
};

/**
 * True when the thread's latest outbound message failed on every channel it went on. Drives the red
 * "Not delivered" fact on the list row, the Communication Filter and the dashboard count.
 */
export function latestOutboundDeliveryFailed(thread: ThreadLike): boolean {
  if (thread.deliveryIssue) return true;
  const messages = thread.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.outbound === false) continue;
    // A message with no `outbound` stamp is the owner's reply only on a thread the owner wrote.
    if (message.outbound === undefined && thread.folder !== "sent") continue;
    return overallDeliveryState(message.deliveries) === "failed";
  }
  if (thread.rootOutbound === true || (thread.rootOutbound === undefined && thread.folder === "sent")) {
    return overallDeliveryState(thread.rootDeliveries) === "failed";
  }
  return false;
}
