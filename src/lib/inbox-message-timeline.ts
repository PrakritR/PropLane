import { formatPacificDateTime } from "@/lib/pacific-time";
import type { InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import type { InboxThreadMessage, PersistedInboxThread } from "@/lib/portal-inbox-storage";

export type InboxBubbleClusterPosition = "single" | "first" | "middle" | "last";

export type InboxTimelineItem =
  | {
      type: "message";
      key: string;
      message: InboxBubbleMessage;
      cluster: InboxBubbleClusterPosition;
      showMeta: boolean;
      showChannel: boolean;
      clusterStart: boolean;
    };

function clusterPosition(sameDirAsPrev: boolean, sameDirAsNext: boolean): InboxBubbleClusterPosition {
  if (sameDirAsPrev && sameDirAsNext) return "middle";
  if (sameDirAsPrev) return "last";
  if (sameDirAsNext) return "first";
  return "single";
}

/** Group consecutive same-direction bubbles (Instagram-style clusters). */
export function buildInboxMessageTimeline(messages: InboxBubbleMessage[]): InboxTimelineItem[] {
  const channels = new Set(messages.map((m) => m.channel ?? "email"));
  const multiChannel = channels.size > 1;
  const items: InboxTimelineItem[] = [];
  const keyOccurrences = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const sameDirAsPrev = prev?.direction === message.direction;
    const sameDirAsNext = next?.direction === message.direction;
    const cluster = clusterPosition(sameDirAsPrev, sameDirAsNext);
    const showMeta = !sameDirAsNext;
    const showChannel = multiChannel && showMeta;
    // Inbox storage de-duplicates known persisted histories, but this shared
    // UI primitive also accepts caller-supplied messages. Keep rendered keys
    // unique if malformed data still contains an id collision.
    const occurrence = keyOccurrences.get(message.id) ?? 0;
    keyOccurrences.set(message.id, occurrence + 1);

    items.push({
      type: "message",
      key: occurrence === 0 ? message.id : `${message.id}#${occurrence + 1}`,
      message,
      cluster,
      showMeta,
      showChannel,
      clusterStart: !sameDirAsPrev,
    });
  }

  return items;
}

export function inboxBubbleClusterRadius(
  outbound: boolean,
  cluster: InboxBubbleClusterPosition,
): string {
  if (outbound) {
    switch (cluster) {
      case "first":
        return "rounded-[1.125rem] rounded-br-md";
      case "middle":
        return "rounded-[1.125rem] rounded-tr-md rounded-br-md";
      case "last":
        return "rounded-[1.125rem] rounded-tr-md";
      default:
        return "rounded-[1.125rem] rounded-br-md";
    }
  }
  switch (cluster) {
    case "first":
      return "rounded-[1.125rem] rounded-bl-md";
    case "middle":
      return "rounded-[1.125rem] rounded-tl-md rounded-bl-md";
    case "last":
      return "rounded-[1.125rem] rounded-tl-md";
    default:
      return "rounded-[1.125rem] rounded-bl-md border border-border bg-secondary text-foreground";
  }
}

/** Optimistic sent row shown immediately after compose — reconciled on server sync. */
export function buildOptimisticSentThread(params: {
  recipientEmail: string;
  subject: string;
  body: string;
  senderLabel: string;
}): PersistedInboxThread {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const when = formatPacificDateTime(new Date());
  const preview = params.body.slice(0, 100).replace(/\n/g, " ");
  return {
    id: `msg_opt_${ts}_${rand}`,
    folder: "sent",
    from: params.senderLabel,
    email: params.recipientEmail.trim().toLowerCase(),
    subject: params.subject.trim(),
    body: params.body.trim(),
    preview,
    time: when,
    unread: false,
    messages: [],
  };
}

export function markThreadMessageDelivery(
  thread: PersistedInboxThread,
  messageId: string,
  delivery: InboxThreadMessage["delivery"],
): PersistedInboxThread {
  if (thread.id === messageId || `${thread.id}-root` === messageId) {
    return thread;
  }
  const messages = thread.messages ?? [];
  if (!messages.some((m) => m.id === messageId)) return thread;
  return {
    ...thread,
    messages: messages.map((m) => (m.id === messageId ? { ...m, delivery } : m)),
  };
}
