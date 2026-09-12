import { formatPacificDate, formatPacificDateTime } from "@/lib/pacific-time";
import { isCanonicalInboxStamp, parseInboxStampMs } from "@/lib/portal-inbox-storage";
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
      /** First bubble of an inbound run — the only one that shows an avatar. */
      showAvatar: boolean;
    }
  | {
      type: "day";
      key: string;
      /** "Today", "Yesterday", or the stored stamp's own date part. */
      label: string;
    };


/**
 * Day key for a stored stamp, in PACIFIC — the same zone every writer stamps in
 * (`formatInboxStamp`). Reading the day in the viewer's own zone would split one
 * conversation's evening across two separators for anyone east of Pacific.
 *
 * Stored stamps carry no year, so `parseInboxStampMs` infers one. A separator
 * spanning a year boundary inherits that inference — the same one the list sort
 * already makes — which is why an unparseable stamp yields no separator at all
 * rather than a guessed date.
 */
function inboxDayKey(at?: string | null): string | null {
  // Only a stamp this app wrote can be read as a DATE. `parseInboxStampMs` is
  // lenient on purpose so ordering never collapses, but a lenient read of a
  // bare "9:00" would print a heading for a day nobody can vouch for.
  if (!isCanonicalInboxStamp(at)) return null;
  const ms = parseInboxStampMs(at);
  if (ms == null) return null;
  return formatPacificDate(ms, { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** "Today" / "Yesterday" / "Sep 7, 2024". */
export function inboxDayLabel(at: string, nowMs: number = Date.now()): string | null {
  if (!isCanonicalInboxStamp(at)) return null;
  const ms = parseInboxStampMs(at);
  if (ms == null) return null;
  const key = inboxDayKey(at);
  if (key && key === formatPacificDate(nowMs, { year: "numeric", month: "2-digit", day: "2-digit" })) {
    return "Today";
  }
  if (
    key &&
    key === formatPacificDate(nowMs - 86_400_000, { year: "numeric", month: "2-digit", day: "2-digit" })
  ) {
    return "Yesterday";
  }
  return formatPacificDate(ms, { month: "short", day: "numeric", year: "numeric" });
}

function clusterPosition(sameDirAsPrev: boolean, sameDirAsNext: boolean): InboxBubbleClusterPosition {
  if (sameDirAsPrev && sameDirAsNext) return "middle";
  if (sameDirAsPrev) return "last";
  if (sameDirAsNext) return "first";
  return "single";
}

/** Group consecutive same-direction bubbles (Instagram-style clusters). */
export function buildInboxMessageTimeline(messages: InboxBubbleMessage[]): InboxTimelineItem[] {
  const items: InboxTimelineItem[] = [];
  const keyOccurrences = new Map<string, number>();

  let lastDayKey: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const prev = messages[i - 1];
    const next = messages[i + 1];

    // A separator both labels the day AND breaks the run above it: without the
    // break a cluster's rounded corners span the divider, which reads as one
    // message split in half.
    const dayKey = inboxDayKey(message.at);
    const dayChanged = dayKey != null && dayKey !== lastDayKey;
    if (dayChanged) {
      const label = inboxDayLabel(message.at);
      if (label) items.push({ type: "day", key: `day-${dayKey}-${i}`, label });
      lastDayKey = dayKey;
    }
    const nextDayKey = next ? inboxDayKey(next.at) : null;
    const nextDayChanged = nextDayKey != null && dayKey != null && nextDayKey !== dayKey;

    const sameDirAsPrev = prev?.direction === message.direction && !dayChanged;
    const sameDirAsNext = next?.direction === message.direction && !nextDayChanged;
    const cluster = clusterPosition(sameDirAsPrev, sameDirAsNext);
    const showMeta = !sameDirAsNext;
    // Every message names its channel beside its time ("Email · 3:42 PM") when
    // the channel is known. An untagged legacy turn shows the time alone rather
    // than a guessed "Email".
    const showChannel = showMeta && message.channel != null;
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
      showAvatar: !sameDirAsPrev,
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
