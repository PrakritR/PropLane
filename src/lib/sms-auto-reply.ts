/**
 * Author label of a server-sent auto-reply on a person's text thread. Not the
 * Assistant chat's own name: a text conversation is titled by its counterparty,
 * never by who wrote its last turn.
 */
export const SMS_AUTO_REPLY_AUTHOR = "You · Assistant";

/** The Assistant chat's own sender name (older auto-replies were authored with it). */
const ASSISTANT_CHAT_AUTHOR = "PropLane Assistant";

export function isAssistantAuthoredLabel(from: string | null | undefined): boolean {
  const name = String(from ?? "").trim();
  return name === SMS_AUTO_REPLY_AUTHOR || name === ASSISTANT_CHAT_AUTHOR || name === "PropLane";
}

type NoticeTurn = { id?: unknown; from?: unknown; outbound?: unknown };

/**
 * A turn the server appended to an SMS notice thread to record the reply it
 * sent (`recordAutoReplyOnSmsNotice`: id `auto_reply_<inbound sid>`, outbound,
 * authored as the assistant). The same text is already a turn of the SMS
 * conversation itself, so a notice that holds only these adds nothing.
 */
export function isSmsAutoReplyEcho(message: NoticeTurn): boolean {
  if (String(message.id ?? "").startsWith("auto_reply_")) return true;
  return message.outbound === true && isAssistantAuthoredLabel(String(message.from ?? ""));
}
