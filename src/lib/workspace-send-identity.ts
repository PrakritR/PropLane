/**
 * Who a workspace's outbound message leaves AS, per channel (captain, Oct 3).
 *
 * Once a workspace has a work number, every message PropLane sends for it goes
 * out through the workspace work identity — SMS from the work number, email from
 * the work email, in-app as the workspace/manager — for manual and automated
 * sends alike. There is no "send from my personal number / email" choice:
 * carriers do not allow SMS from a personal handset, and a manager's login
 * address is an account credential, not a sender.
 *
 * This module is the single pure decision. It takes only server-resolved facts
 * (the workspace's work number and work email) and an optional caller HINT that
 * is never trusted: a hint asking for "personal" is ignored whether or not a
 * work number exists, because no personal sender exists to hand back.
 *
 * Before a work number exists nothing changes from today: SMS is unavailable
 * (the compose menu already disables it), email keeps the shared PropLane
 * sender (or the work email, if the workspace set one up first), and in-app
 * stays the manager.
 */
import type { DeliverViaChannels } from "@/lib/manager-communication-deliver-via";

export type WorkspaceSendIdentityInput = {
  /** E.164 of the workspace's work number, or null when it has none. */
  workNumber?: string | null;
  /** True once the work number can actually carry a send (carrier-approved). */
  workNumberCanSend?: boolean;
  /** The workspace's work email address, or null when it has none. */
  workEmail?: string | null;
};

export type SmsSender =
  | { kind: "work_number"; from: string }
  | { kind: "unavailable" };

export type EmailSender =
  | { kind: "work_email"; address: string }
  | { kind: "shared_sender" };

export type InAppSender = { kind: "workspace_manager" };

export type WorkspaceSendIdentity = {
  /** The workspace has a work number set up (sendable or still registering). */
  hasWorkNumber: boolean;
  sms: SmsSender;
  email: EmailSender;
  inApp: InAppSender;
};

export type SendChannel = "sms" | "email" | "inApp";

/** What a caller may ask for. Anything but "work" is a request for a sender that does not exist. */
export type RequestedSender = "work" | "personal" | null | undefined;

export function resolveWorkspaceSendIdentity(input: WorkspaceSendIdentityInput): WorkspaceSendIdentity {
  const workNumber = input.workNumber?.trim() || "";
  const workEmail = input.workEmail?.trim() || "";
  return {
    hasWorkNumber: workNumber.length > 0,
    sms:
      workNumber && input.workNumberCanSend === true
        ? { kind: "work_number", from: workNumber }
        : { kind: "unavailable" },
    email: workEmail ? { kind: "work_email", address: workEmail } : { kind: "shared_sender" },
    inApp: { kind: "workspace_manager" },
  };
}

/**
 * The sender for one channel. `requested` is accepted only so a caller (or a
 * request body) that asks for "personal" gets the workspace identity anyway —
 * the answer never depends on it.
 */
export function senderForChannel(
  identity: WorkspaceSendIdentity,
  channel: "sms",
  requested?: RequestedSender,
): SmsSender;
export function senderForChannel(
  identity: WorkspaceSendIdentity,
  channel: "email",
  requested?: RequestedSender,
): EmailSender;
export function senderForChannel(
  identity: WorkspaceSendIdentity,
  channel: "inApp",
  requested?: RequestedSender,
): InAppSender;
export function senderForChannel(
  identity: WorkspaceSendIdentity,
  channel: SendChannel,
  _requested?: RequestedSender,
): SmsSender | EmailSender | InAppSender {
  if (channel === "sms") return identity.sms;
  if (channel === "email") return identity.email;
  return identity.inApp;
}

export type DeliverViaWithSenders = DeliverViaChannels & {
  senders: {
    sms: SmsSender | null;
    email: EmailSender | null;
    inApp: InAppSender | null;
  };
};

/**
 * Pair a deliver-via choice (which channels are on) with the identity each
 * enabled channel leaves as. SMS asked for without a sendable work number is
 * switched off rather than rerouted: there is nowhere else to send it from.
 */
export function deliverViaWithSenders(
  channels: DeliverViaChannels,
  identity: WorkspaceSendIdentity,
  requested?: RequestedSender,
): DeliverViaWithSenders {
  const sms = channels.viaSms ? senderForChannel(identity, "sms", requested) : null;
  const smsOn = sms?.kind === "work_number";
  return {
    viaEmail: channels.viaEmail,
    viaSms: smsOn,
    viaInbox: channels.viaInbox,
    senders: {
      sms: smsOn ? sms : null,
      email: channels.viaEmail ? senderForChannel(identity, "email", requested) : null,
      inApp: channels.viaInbox !== false ? senderForChannel(identity, "inApp", requested) : null,
    },
  };
}
