/**
 * Who a record's Communication pane is WITH.
 *
 * A stored inbox thread's `from` is whoever wrote its first turn. On a manager's SENT thread that is
 * the manager - so titling the pane with `thread.from` showed the viewer's own name ("Test Manager")
 * over a service whose counterparty is the resident. The counterparty is the record's contact, so the
 * record names it; the thread only supplies a name when it is genuinely the other side's.
 */

type ThreadLike = {
  folder?: string;
  from?: string;
  email?: string;
  rootOutbound?: boolean;
};

/** True when the thread's first turn was written by the viewer (so `from` is the viewer, not the contact). */
export function threadIsOutbound(thread: ThreadLike | null | undefined): boolean {
  return Boolean(thread && (thread.folder === "sent" || thread.rootOutbound === true));
}

/**
 * A thread addressed to the viewer's own email is a self-thread (their copy of a notice they sent). A
 * record pane is always with somebody else, so it is never part of the contact's conversation - even
 * when a bad lookup resolved the contact to the viewer's own address.
 */
export function isSelfThread(thread: ThreadLike | null | undefined, viewerEmail: string | null | undefined): boolean {
  const viewer = (viewerEmail ?? "").trim().toLowerCase();
  const email = (thread?.email ?? "").trim().toLowerCase();
  return Boolean(viewer && email && email === viewer);
}

export function resolveCounterpartyName(input: {
  /** The record's contact, by name ("Liam Foster") - authoritative when the panel knows it. */
  contactName?: string | null;
  thread?: ThreadLike | null;
  /** The record's own label, used only when nothing names the other side. */
  recordLabel?: string | null;
  recipientEmail?: string | null;
}): string {
  const contact = input.contactName?.trim();
  if (contact) return contact;
  const thread = input.thread;
  if (thread && !threadIsOutbound(thread)) {
    const from = thread.from?.trim();
    if (from) return from;
  }
  return input.recordLabel?.trim() || input.recipientEmail?.trim() || "Contact";
}
