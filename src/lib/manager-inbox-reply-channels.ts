import { normalizeE164 } from "@/lib/phone-e164";
import { trimmedText } from "@/lib/trimmed-text";

/**
 * Channel availability + defaults for manager email-inbox replies (including AI
 * drafts). Phone-only work-number texters must land on SMS; email without `@`
 * must never stay selected as a live channel.
 */

export function inboxThreadHasEmail(email: string | null | undefined): boolean {
  return String(email ?? "").trim().includes("@");
}

function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function samePhone(a: string, b: string): boolean {
  const left = phoneDigits(a);
  const right = phoneDigits(b);
  return left.length >= 10 && right.length >= 10 && left.slice(-10) === right.slice(-10);
}

/** Prefer a resolvable E.164 from `from`, then from a phone-shaped `email` field. */
export function inboxThreadPhoneHint(thread: {
  from?: string | null;
  email?: string | null;
}): string | null {
  for (const raw of [thread.from, thread.email]) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const e164 = normalizeE164(value);
    if (e164) return e164;
  }
  return null;
}

export type ManagerInboxSmsTarget = {
  phone: string;
  residentEmail: string | null;
  residentUserId: string | null;
  conversationKey: string | null;
};

export type ManagerInboxSmsRecipientLike = {
  phone?: string | null;
  residentEmail?: string | null;
  residentUserId?: string | null;
  conversationKey?: string | null;
};

/**
 * Resolve who an SMS reply should hit for this inbox thread. Matches directory /
 * SMS conversation rows by email or phone; falls back to the thread's own phone
 * hint so a leasing prospect who only texted the work number stays reachable.
 */
export function resolveManagerInboxSmsTarget(
  thread: { from?: string | null; email?: string | null },
  smsRecipients: ManagerInboxSmsRecipientLike[],
  /** True when the manager may send from their work number (UI flag and/or canSend). */
  smsOutboundEnabled: boolean,
): ManagerInboxSmsTarget | null {
  if (!smsOutboundEnabled) return null;

  const email = String(thread.email ?? "").trim().toLowerCase();
  if (inboxThreadHasEmail(email)) {
    const byEmail = smsRecipients.find(
      (row) =>
        trimmedText(row.residentEmail).toLowerCase() === email && Boolean(trimmedText(row.phone)),
    );
    const emailPhone = normalizeE164(byEmail?.phone) ?? trimmedText(byEmail?.phone);
    if (byEmail && emailPhone) {
      return {
        phone: emailPhone,
        residentEmail: trimmedText(byEmail.residentEmail) || null,
        residentUserId: byEmail.residentUserId ?? null,
        conversationKey: byEmail.conversationKey ?? null,
      };
    }
  }

  const phoneHint = inboxThreadPhoneHint(thread);
  if (!phoneHint) return null;

  const byPhone = smsRecipients.find((row) => {
    const phone = trimmedText(row.phone);
    if (!phone) return false;
    return normalizeE164(phone) === phoneHint || samePhone(phone, phoneHint);
  });
  const matchedPhone = normalizeE164(byPhone?.phone) ?? trimmedText(byPhone?.phone);
  if (byPhone && matchedPhone) {
    return {
      phone: matchedPhone,
      residentEmail: trimmedText(byPhone.residentEmail) || null,
      residentUserId: byPhone.residentUserId ?? null,
      conversationKey: byPhone.conversationKey ?? null,
    };
  }

  return {
    phone: phoneHint,
    residentEmail: null,
    residentUserId: null,
    conversationKey: null,
  };
}

/**
 * Clamp preferred deliver-via settings to what this counterparty can actually
 * receive. When only one channel exists, that channel wins regardless of the
 * saved preference.
 */
export function resolveManagerInboxReplyChannels(args: {
  emailAvailable: boolean;
  smsAvailable: boolean;
  preferred: { viaEmail: boolean; viaSms: boolean };
}): { viaEmail: boolean; viaSms: boolean } {
  let viaEmail = args.preferred.viaEmail && args.emailAvailable;
  let viaSms = args.preferred.viaSms && args.smsAvailable;
  if (!viaEmail && !viaSms) {
    if (args.smsAvailable) viaSms = true;
    else if (args.emailAvailable) viaEmail = true;
  }
  return { viaEmail, viaSms };
}

/** User-visible reason when Text is disabled in Send via — missing phone vs deployment off. */
export function inboxSmsUnavailableReason(args: {
  smsAvailable: boolean;
  smsOutboundEnabled: boolean;
  smsUiEnabled: boolean;
}): string | undefined {
  if (args.smsAvailable) return undefined;
  if (!args.smsUiEnabled || !args.smsOutboundEnabled) return "Texting is off for this conversation";
  return "No phone number on this conversation";
}

/** Unified Communication composer: deliver on every channel the counterparty can receive. */
export function resolvePropLaneUnifiedReplyChannels(args: {
  emailAvailable: boolean;
  smsAvailable: boolean;
}): { viaEmail: boolean; viaSms: boolean } {
  return {
    viaEmail: args.emailAvailable,
    viaSms: args.smsAvailable,
  };
}

export type InboxReplyChannelFlags = {
  viaEmail: boolean;
  viaSms: boolean;
  viaProplane: boolean;
};

/** PropLane Assistant threads default to in-app PropLane; external channels are opt-in. */
export function resolveAssistantInboxReplyChannels(    args: {
  emailAvailable: boolean;
  smsAvailable: boolean;
}): InboxReplyChannelFlags {
  void args;
  return {
    viaProplane: true,
    viaEmail: false,
    viaSms: false,
  };
}

/**
 * Person threads in Communication reply on the channel the person last reached
 * us on: an email is answered by email, a text by text, a portal message
 * in-app. A thread with no stamped inbound (legacy rows, or one the manager
 * started) keeps the in-app default with email/SMS opt-in.
 *
 * The rule exists because the old in-app-only default let a manager answer a
 * prospect who had only ever emailed the work address — the reply landed on a
 * PropLane row nobody could read, and the bubble still said EMAIL.
 */
export function resolveCommunicationPersonThreadReplyChannels(args: {
  emailAvailable: boolean;
  smsAvailable: boolean;
  lastInboundChannel?: "email" | "sms" | "proplane" | null;
  /**
   * Whether an in-app message can reach this person (they have a PropLane
   * account). Omitted means yes. False makes In-app unselectable, so a
   * phone-only prospect lands on Text and an email-only one on Email instead
   * of on a channel that cannot deliver.
   */
  proplaneAvailable?: boolean;
}): InboxReplyChannelFlags {
  const proplaneAvailable = args.proplaneAvailable !== false;
  if (args.lastInboundChannel === "email" && args.emailAvailable) {
    return { viaProplane: false, viaEmail: true, viaSms: false };
  }
  if (args.lastInboundChannel === "sms" && args.smsAvailable) {
    return { viaProplane: false, viaEmail: false, viaSms: true };
  }
  if (proplaneAvailable) {
    return { viaProplane: true, viaEmail: false, viaSms: false };
  }
  // In-app cannot reach them and the last inbound channel is unknown or
  // unavailable: take whichever external channel exists, text first (a
  // phone-only texter is the common case), never an unreachable In-app.
  return {
    viaProplane: false,
    viaEmail: !args.smsAvailable && args.emailAvailable,
    viaSms: args.smsAvailable,
  };
}

export type ReplyChannelMemory = {
  /** The last inbound channel when the person last chose, so a NEW inbound on a different channel resets it. */
  inbound: "email" | "sms" | "proplane" | null;
  flags: InboxReplyChannelFlags;
};

/**
 * The composer's channel for a thread: the channel of the last inbound message,
 * sticky per thread. A manual pick is remembered while the last inbound channel
 * is unchanged; only a new inbound on a different channel (or a remembered
 * channel that stopped being available) goes back to the inbound-channel
 * default. In-app is only ever selected when the person is reachable there.
 */
export function resolveStickyReplyChannels(args: {
  emailAvailable: boolean;
  smsAvailable: boolean;
  proplaneAvailable: boolean;
  lastInboundChannel: "email" | "sms" | "proplane" | null;
  remembered?: ReplyChannelMemory | null;
}): InboxReplyChannelFlags {
  const remembered = args.remembered;
  if (remembered && remembered.inbound === args.lastInboundChannel) {
    const flags: InboxReplyChannelFlags = {
      viaEmail: remembered.flags.viaEmail && args.emailAvailable,
      viaSms: remembered.flags.viaSms && args.smsAvailable,
      viaProplane: remembered.flags.viaProplane && args.proplaneAvailable,
    };
    if (hasInboxReplyChannelSelected(flags)) return flags;
  }
  return resolveCommunicationPersonThreadReplyChannels({
    emailAvailable: args.emailAvailable,
    smsAvailable: args.smsAvailable,
    lastInboundChannel: args.lastInboundChannel,
    proplaneAvailable: args.proplaneAvailable,
  });
}

/**
 * Whether an in-app (PropLane) message can reach this thread's person: an
 * assistant/team thread always can; a person thread only when the sender can
 * resolve a portal recipient (an email address, or an SMS contact tied to an
 * account). A phone-only prospect has no PropLane account to read it.
 */
export function inboxThreadPortalReachable(args: {
  thread: { from?: string | null; email?: string | null };
  smsRecipients: ManagerInboxSmsRecipientLike[];
  smsOutboundEnabled: boolean;
  /** Assistant and team threads reply in-app with no person counterparty. */
  inAppOnlyThread?: boolean;
}): boolean {
  if (args.inAppOnlyThread) return true;
  return (
    resolveManagerInboxPortalRecipient(args.thread, args.smsRecipients, args.smsOutboundEnabled) !== null
  );
}

export function hasInboxReplyChannelSelected(channels: InboxReplyChannelFlags): boolean {
  return channels.viaEmail || channels.viaSms || channels.viaProplane;
}

/** Counterparty for portal-only delivery on a person thread (not assistant). */
export function resolveManagerInboxPortalRecipient(
  thread: { from?: string | null; email?: string | null },
  smsRecipients: ManagerInboxSmsRecipientLike[],
  smsOutboundEnabled: boolean,
): { toEmails?: string[]; toUserIds?: string[] } | null {
  const email = String(thread.email ?? "").trim().toLowerCase();
  if (inboxThreadHasEmail(email)) return { toEmails: [email] };
  const smsTarget = resolveManagerInboxSmsTarget(thread, smsRecipients, smsOutboundEnabled);
  if (smsTarget?.residentUserId) return { toUserIds: [smsTarget.residentUserId] };
  return null;
}
