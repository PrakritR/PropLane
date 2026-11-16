import { ASSISTANT_TURN_LABEL } from "@/lib/assistant-review/model";

/**
 * Is this thread turn the PropLane Assistant ANSWERING a person (as opposed to an event card or a notice the Assistant
 * posts)? The resident-thread auto-reply writes an automated turn signed "PropLane Assistant" whose subject is also
 * "PropLane Assistant"; a notice carries a real subject. An answer is drawn as a labeled bubble with its time and the
 * Flag / Correct controls, never as a one-line activity row.
 */
export function isAssistantReplyTurn(message: { automated?: boolean; author?: string; eventTitle?: string; direction?: string; eventKind?: unknown }): boolean {
  if (!message.automated || message.eventKind) return false;
  if (message.direction === "system") return false;
  return (message.author ?? "").trim() === ASSISTANT_TURN_LABEL && (message.eventTitle ?? "").trim() === ASSISTANT_TURN_LABEL;
}

/** The text of the last turn from the other side before `messageId`: what the person asked. */
export function lastInboundBefore(messages: ReadonlyArray<{ id: string; body: string; direction: string; automated?: boolean }>, messageId: string): string {
  const at = messages.findIndex((m) => m.id === messageId);
  for (let i = (at < 0 ? messages.length : at) - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.direction === "inbound" && !m.automated) return m.body;
  }
  return "";
}
