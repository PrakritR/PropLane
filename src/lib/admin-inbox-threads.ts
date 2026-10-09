/**
 * Admin inbox messages as unified-inbox conversations.
 *
 * Admin stores its inbox as `InboxMessage` rows (a root message plus a thread of
 * replies, folder inbox | sent | trash, a single `read` flag). The unified
 * Communication inbox is built over `PersistedInboxThread`. This module is the
 * pure mapping between the two, so the admin page reuses the manager's list
 * model, merge rules and Active | Archived tabs unchanged.
 *
 * It is lossless in the direction that matters: the id is the message id, the
 * stored folder maps to the same folder (`trashedFrom` -> `previousFolder`), and
 * a reply keeps its author, so archive / restore / delete and the reply path
 * keep addressing the original row.
 */
import type { InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import type { InboxMessage } from "@/lib/demo-admin-partner-inbox";
import {
  formatInboxStamp,
  inboxMessageOutbound,
  inboxThreadMessages,
  inboxThreadSortMs,
  parseInboxStampMs,
  type InboxThreadMessage,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { isUpcomingScheduledInboxMessage } from "@/lib/scheduled-inbox-messages";

/**
 * The author label admin's own reply has always been stamped with
 * (`appendThreadReply(id, "PropLane admin", text)`). A reply is the admin's own
 * turn when it carries this label, and the counterparty's otherwise.
 */
export const ADMIN_REPLY_AUTHOR_LABEL = "PropLane admin";

/** Id prefix of the conversation drawn for a scheduled send to someone never messaged. */
export const ADMIN_SCHEDULED_STUB_PREFIX = "scheduled-";

export function isAdminScheduledStubId(id: string): boolean {
  return id.startsWith(ADMIN_SCHEDULED_STUB_PREFIX);
}

function stampOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatInboxStamp(date);
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** True when the message is a conversation admin started (a composed message), trashed or not. */
export function adminMessageIsSent(message: Pick<InboxMessage, "folder" | "trashedFrom">): boolean {
  return message.folder === "sent" || (message.folder === "trash" && message.trashedFrom === "sent");
}

const BROADCAST_AUDIENCES = new Set(["all", "all_managers", "all_residents", "multi"]);

/** The one address this conversation is with, or "" for a broadcast / multi-recipient send. */
function counterpartyEmail(message: InboxMessage): string {
  if (adminMessageIsSent(message)) {
    if (message.composeAudience && BROADCAST_AUDIENCES.has(message.composeAudience)) return "";
    // A multi-pick compose joins its addresses with "; " - not one person's address.
    if (message.email.includes(";")) return "";
  }
  return message.email.trim();
}

export function adminInboxMessageToThread(message: InboxMessage): PersistedInboxThread {
  const sent = adminMessageIsSent(message);
  const label = sent ? (message.composeRecipientLabel?.trim() || message.name) : message.name;
  const messages: InboxThreadMessage[] = message.thread.map((reply) => ({
    id: reply.id,
    from: reply.authorLabel,
    body: reply.body,
    at: stampOf(reply.createdAt),
    outbound: reply.authorLabel === ADMIN_REPLY_AUTHOR_LABEL,
  }));
  const last = message.thread[message.thread.length - 1];
  const email = counterpartyEmail(message);
  return {
    id: message.id,
    folder: message.folder,
    ...(message.folder === "trash"
      ? { previousFolder: message.trashedFrom === "sent" ? ("sent" as const) : ("inbox" as const) }
      : {}),
    from: label,
    email,
    subject: message.topic,
    preview: message.body,
    body: message.body,
    time: stampOf(last?.createdAt ?? message.createdAt),
    unread: message.folder === "inbox" && !message.read,
    rootOutbound: sent,
    rootAt: stampOf(message.createdAt),
    messages,
  };
}

/**
 * The conversation drawn for a scheduled send whose recipient admin has never
 * messaged. A scheduled send must be reachable and cancellable from a thread
 * (there is no separate Scheduled view), and without a conversation row it has
 * no thread to sit in.
 */
export function adminScheduledStubThread(record: ScheduledInboxMessageRecord): PersistedInboxThread {
  const email = normalizeEmail(record.recipientEmail);
  const stamp = stampOf(record.createdAt);
  return {
    id: `${ADMIN_SCHEDULED_STUB_PREFIX}${email}`,
    folder: "sent",
    from: record.recipientName?.trim() || email,
    email,
    subject: record.subject,
    preview: "",
    body: "",
    time: stamp,
    unread: false,
    rootOutbound: true,
    rootAt: stamp,
    messages: [],
  };
}

/**
 * Every admin conversation: the stored messages, plus a stub for each pending
 * scheduled send to an address no stored message is with.
 */
export function adminThreadsFrom(
  messages: readonly InboxMessage[],
  scheduled: readonly ScheduledInboxMessageRecord[] = [],
): PersistedInboxThread[] {
  const threads = messages.map(adminInboxMessageToThread);
  const known = new Set(
    threads.filter((thread) => thread.folder !== "trash").map((thread) => normalizeEmail(thread.email)).filter(Boolean),
  );
  const stubs = new Map<string, PersistedInboxThread>();
  for (const record of scheduled) {
    if (record.status !== "scheduled" && record.status !== "sending") continue;
    if (!isUpcomingScheduledInboxMessage(record.sendAt, record.status)) continue;
    const email = normalizeEmail(record.recipientEmail);
    if (!email || known.has(email) || stubs.has(email)) continue;
    stubs.set(email, adminScheduledStubThread(record));
  }
  return [...threads, ...stubs.values()];
}

/** One conversation's messages, every stored thread folded in, oldest first. */
export function adminThreadBubbles(threads: PersistedInboxThread[]): InboxBubbleMessage[] {
  const rows = threads.flatMap((thread) =>
    inboxThreadMessages(thread).map((message, index) => ({
      thread,
      message,
      sortMs: parseInboxStampMs(message.at) ?? inboxThreadSortMs(thread.id, thread.time),
      outbound: inboxMessageOutbound(message, index, thread.folder, thread),
    })),
  );
  rows.sort((a, b) => a.sortMs - b.sortMs);
  return rows.map(({ message, outbound }) => ({
    id: message.id,
    author: message.from,
    body: message.body,
    at: message.at,
    direction: outbound ? ("outbound" as const) : ("inbound" as const),
  }));
}
