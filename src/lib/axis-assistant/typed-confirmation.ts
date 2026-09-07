import type { PendingAction } from "@/lib/axis-assistant/use-assistant-conversation";

/**
 * Typed send confirmation.
 *
 * A manager reviewing a "send message" preview can approve it by typing an
 * explicit send command in the composer instead of clicking Confirm. The
 * decision is deliberately narrow and pure so it can be tested exhaustively:
 *
 * - Only the author's standalone command counts. A question ("send?"), a
 *   negation ("don't send"), an edit ("send after changing the date"), a quoted
 *   word, or any extra words are ordinary chat, never approval.
 * - Only an immediate message proposal may be approved this way
 *   (`TYPED_CONFIRMATION_ACTION_KINDS`). A bare "send" must never approve a
 *   payment, a deletion, a reminder blast, or a scheduled send — those keep
 *   the card's own Confirm button.
 * - Attachments disqualify: a send with a file is a new request, not a yes.
 * - The confirmation still travels the ONE confirm transport
 *   (`resolvePendingAction("confirm")` → `{ confirmActionId }`), so ownership,
 *   expiry, stored-input revalidation and exactly-once claiming stay server-side.
 *
 * The conversation transport holds at most one pending action at a time, so a
 * null/undefined `pendingAction` is the "nothing awaiting confirmation" case.
 */
export const TYPED_CONFIRMATION_ACTION_KINDS: readonly string[] = [
  "send_message",
  "reply_to_thread",
  "send_message_to_manager",
];

const TYPED_SEND_COMMAND =
  /^(?:yes,?\s+)?(?:send|send it|send the message|send the reply|send the email|send this)[.!]?$/i;

/** True when `text` is an explicit standalone send command such as "send" or "yes, send". */
export function parseTypedConfirmation(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  return TYPED_SEND_COMMAND.test(normalized);
}

/**
 * The single pending action that a typed command should confirm, or null when
 * the text must instead be sent as an ordinary message.
 */
export function typedConfirmationTarget(
  text: string,
  pendingAction: PendingAction | null | undefined,
  attachmentCount = 0,
): PendingAction | null {
  if (!pendingAction) return null;
  if (attachmentCount > 0) return null;
  if (!TYPED_CONFIRMATION_ACTION_KINDS.includes(pendingAction.preview.kind)) return null;
  return parseTypedConfirmation(text) ? pendingAction : null;
}
