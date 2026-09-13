/** Shared, plain-text copy for the one-time tour interest nudge. */
export const TOUR_INTEREST_BODY = "Hi, are you still interested in a tour? Reply and we can find a time that works for you.";
export const TOUR_INTEREST_DELAY_MS = 24 * 60 * 60 * 1000;
export const TOUR_INTEREST_PURPOSE = "tour_interest_followup";

/** A successful, current availability lookup is explicit tour context. Never infer from a keyword in a message. */
export function tourInterestProperty(context: unknown, inboundAt: string): string | null {
  if (!Array.isArray(context) || !Number.isFinite(Date.parse(inboundAt))) return null;
  const facts = context.filter((item) => item && typeof item === "object");
  const inquiry = facts.some((item) => item.tool === "request_tour" && item.output?.ok !== false && Date.parse(item.recordedAt) >= Date.parse(inboundAt));
  if (inquiry) return null;
  for (const fact of [...facts].reverse()) {
    if (fact.tool !== "list_open_tour_slots" || Date.parse(fact.recordedAt) < Date.parse(inboundAt)) continue;
    if (!Number.isFinite(Date.parse(fact.recordedAt)) || fact.output?.ok === false ||
      fact.output?.resolution !== "resolved" || !Array.isArray(fact.output?.slots) || fact.output.slots.length === 0) continue;
    const id = fact.input?.propertyId;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

/** Reminder resolution means enqueued. Only the provider outbox describes delivery. */
export function followupDelivery(row: { status: string }, outbox?: { status: string; dispatch_started_at?: string | null; provider_message_sid?: string | null; blocked_reason?: string | null }) {
  const cancellable = !outbox || (!outbox.dispatch_started_at && !outbox.provider_message_sid && ["queued", "deferred", "claimed", "blocked"].includes(outbox.status));
  const status = row.status === "cancelled" && cancellable ? "cancelled" : outbox
    ? outbox.status === "blocked" ? (outbox.blocked_reason === "tour_followup_cancelled" ? "cancelled" : "failed")
      : ["queued", "deferred"].includes(outbox.status) ? "queued"
      : ["claimed", "submitting", "submitted"].includes(outbox.status) ? "sending" : outbox.status
    : row.status === "sent" ? "unknown" : row.status;
  return { status, canEdit: row.status === "scheduled" && !outbox,
    canCancel: ["scheduled", "sending", "sent"].includes(row.status) && cancellable && (row.status !== "sent" || Boolean(outbox)) };
}
