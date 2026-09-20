import { looksLikeEmailQuoteBlock, stripEmailReplyQuote } from "@/lib/inbound-email/strip-email-reply-quote";
import {
  inboxThreadMessages,
  inboxThreadSortMs,
  type InboxThreadMessageChannel,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

/**
 * What the thread UI shows for one turn: subject + the new message, never
 * quoted Gmail/Outlook history. SMS and in-app turns are left alone.
 */
export function inboxTurnDisplayBody(
  body: string,
  channel?: InboxThreadMessageChannel | null,
): string {
  if (channel === "sms" || channel === "proplane") return body;
  if (channel === "email" || looksLikeEmailQuoteBlock(body)) {
    return stripEmailReplyQuote(body);
  }
  return body;
}

/** "Re: Re: Propert" and "Propert" are the same topic for the bubble's subject line. */
export function emailSubjectTopic(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|fwd?)\s*:\s*)+/i, "").trim().toLowerCase();
}

/** "Re: <subject>" for an emailed reply — matches the outbound work-email path. */
export function emailReplySubjectFor(subject: string | null | undefined): string {
  const trimmed = String(subject ?? "").trim();
  if (!trimmed || trimmed === "(no subject)") return "Re: PropLane";
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Body (quote-stripped) plus the subject line only when this turn starts a
 * new topic — a run of "Re: …" replies shows the subject once.
 */
export function inboxEmailBubbleFields(
  turn: { body: string; subject?: string | null; channel?: InboxThreadMessageChannel | null },
  lastShownSubject: string,
): { body: string; subject?: string; lastShownSubject: string } {
  const channel = turn.channel ?? null;
  const body = inboxTurnDisplayBody(turn.body, channel);
  if (channel === "sms" || channel === "proplane") {
    return { body, lastShownSubject };
  }
  const subject = String(turn.subject ?? "").trim();
  const show = Boolean(subject) && emailSubjectTopic(subject) !== emailSubjectTopic(lastShownSubject);
  return {
    body,
    ...(show ? { subject } : {}),
    lastShownSubject: subject ? subject : lastShownSubject,
  };
}

/** Latest email subject on a person-thread set, for `Re:` on the next send. */
export function latestEmailSubjectFromThreads(threads: readonly PersistedInboxThread[]): string {
  let best = "";
  let bestMs = -1;
  for (const thread of threads) {
    if (thread.folder === "trash") continue;
    for (const [index, turn] of inboxThreadMessages(thread).entries()) {
      const subject = String(turn.subject ?? (index === 0 ? thread.subject : "")).trim();
      if (!subject) continue;
      const ms = inboxThreadSortMs(turn.id, turn.at);
      if (ms >= bestMs) {
        bestMs = ms;
        best = subject;
      }
    }
  }
  return best;
}
