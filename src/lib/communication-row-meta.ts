/**
 * The third line of a conversation row: the house it is about, and what it is
 * about.
 *
 * Both are deliberately absent-by-default. A row that cannot resolve an address
 * shows no address, and a conversation with no recorded category shows no chip.
 * The alternative — guessing a topic from the subject line — labels a rent
 * reminder "Tour" the first time somebody writes "touring the payment options",
 * and a wrong label is worse than none.
 */
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { inboxThreadMessages, inboxMessageOutbound } from "@/lib/portal-inbox-storage";

/**
 * Display labels for the categories the send path stamps
 * (`NotificationCategory` in notification-preferences.ts). Anything else — an
 * unrecognised value, or no value at all — yields no chip.
 */
const CATEGORY_LABELS: Record<string, string> = {
  leases: "Lease",
  payments: "Payments",
  maintenance: "Maintenance",
  applications: "Application",
  tours: "Tour",
  // `messages` is the generic bucket. It says nothing a reader does not already
  // know from being in an inbox, so it earns no chip.
};

export function inboxThreadCategoryLabel(thread: {
  category?: string | null;
}): string | undefined {
  const raw = String(thread.category ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  return CATEGORY_LABELS[raw];
}

/**
 * Unread INBOUND turns at the tail of a thread — the messages the reader has
 * not answered.
 *
 * There is no per-message read marker in the product, so this is derived rather
 * than stored: it is only meaningful on a thread already flagged unread, and it
 * counts back to the reader's own last turn. A thread whose messages were never
 * expanded into `messages[]` (a single-turn notice) is one message.
 */
export function inboxThreadUnreadCount(thread: PersistedInboxThread): number {
  if (!thread.unread) return 0;
  const messages = inboxThreadMessages(thread);
  if (messages.length === 0) return 1;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (inboxMessageOutbound(messages[i]!, i, thread.folder, thread)) break;
    count++;
  }
  return count || 1;
}

/**
 * Street line for a house label. Property labels arrive in several shapes —
 * a full address, an "Address · Room" composite, or (when a lease row carried
 * no label at all) a raw property id. Only the first two are worth showing; an
 * id tells a resident nothing and looks like a bug.
 */
export function inboxRowAddressLabel(value: string | null | undefined): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  // uuid, or an opaque slug with no spaces and no digits-then-street shape.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return undefined;
  const head = raw.split("·")[0]!.trim();
  const street = head.split(",")[0]!.trim();
  return street || undefined;
}
