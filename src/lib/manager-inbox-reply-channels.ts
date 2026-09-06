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
    const emailPhone = trimmedText(byEmail?.phone);
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
  const matchedPhone = trimmedText(byPhone?.phone);
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

/** Person threads in Communication default to in-app PropLane; email/SMS stay opt-in. */
export function resolveCommunicationPersonThreadReplyChannels(args: {
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
