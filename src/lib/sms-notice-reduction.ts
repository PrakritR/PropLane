import { isAssistantAuthoredLabel, isSmsAutoReplyEcho } from "@/lib/sms-auto-reply";

/**
 * What a stored SMS notice thread still contributes once the SMS projection
 * carries its originals. The projection is the conversation; the notice is a
 * compatibility row that survives only for turns the projection does not hold
 * (a manager's annotation, an unbound original).
 *
 * The bug this exists for: the server-recorded auto-reply turns
 * (`auto_reply_<sid>`, authored "You · Assistant") carry no original-SMS
 * marker, so they were never suppressed. With the inbound original projected,
 * the first leftover turn was promoted to the row's root and its author became
 * the row's `from`, leaving a second row for the same conversation, titled by
 * the assistant, unread from the notice's own flag.
 */
export type NoticeMarker = {
  sourceNamespace: string;
  sourceEventId: string;
  ownerManagerUserId: string;
  counterpartyRole: string;
  workLineId: string;
  occurredAt: string;
  bodySha256: string;
};

export function asNoticeMarker(value: unknown): NoticeMarker | null {
  if (!value || typeof value !== "object") return null;
  const marker = value as NoticeMarker;
  return marker.sourceNamespace && marker.sourceEventId && marker.ownerManagerUserId && marker.counterpartyRole &&
    marker.workLineId && marker.occurredAt && marker.bodySha256
    ? marker
    : null;
}

type Row = Record<string, unknown>;

/**
 * Returns the row to show, or `null` when nothing of it remains. `isProjected`
 * answers for an exact original marker.
 */
export function reduceSmsNoticeRow(
  row: Row,
  isProjected: (marker: NoticeMarker | null) => boolean | null,
): Row | null {
  const all = Array.isArray(row.messages) ? (row.messages as Row[]) : [];
  const rootProjected = isProjected(asNoticeMarker(row.rootOriginalSmsEvent));
  // The reply that answered a projected original is the projection's own
  // outbound turn: drop its echo with the original it answered.
  const remaining = all.filter(
    (message) => !isProjected(asNoticeMarker(message.originalSmsEvent)) && !(rootProjected && isSmsAutoReplyEcho(message)),
  );
  const counterpartyFrom = (candidate: unknown) =>
    isAssistantAuthoredLabel(String(candidate ?? "")) ? row.from : candidate;
  if (!rootProjected) {
    const latest = remaining.at(-1);
    return {
      ...row,
      messages: remaining,
      preview: String(latest?.body ?? row.body ?? "").slice(0, 100),
      time: latest?.at ?? row.rootAt ?? row.time,
    };
  }
  const [first, ...rest] = remaining;
  if (!first) return null;
  const latest = rest.at(-1) ?? first;
  return {
    ...row,
    rootMessageId: first.id,
    rootAt: first.at,
    rootOriginalSmsEvent: first.originalSmsEvent,
    body: first.body,
    // A text conversation is named by its counterparty, never by a turn's author.
    from: counterpartyFrom(first.from),
    messages: rest,
    preview: String(latest.body ?? "").slice(0, 100),
    time: latest.at ?? first.at,
  };
}
