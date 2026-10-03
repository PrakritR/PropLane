type InboxTurnForReadReceipt = {
  direction: "inbound" | "outbound" | "assistant" | "system";
  delivery?: "sending" | "sent" | "failed";
  readByRecipient?: boolean;
};

/**
 * When a later inbound turn exists, treat the outbound turn as read for UI ticks.
 * Provider-level read receipts are not stored per SMS/email turn yet; a reply is
 * the honest signal both channels share.
 */
export function annotateInboxOutboundReadReceipts<T extends InboxTurnForReadReceipt>(messages: T[]): T[] {
  return messages.map((message, index) => {
    if (message.direction !== "outbound") return message;
    if (message.delivery === "sending" || message.delivery === "failed") return message;
    const readByReply = messages.slice(index + 1).some((turn) => turn.direction === "inbound");
    if (!readByReply && !message.readByRecipient) return message;
    return { ...message, readByRecipient: true };
  });
}
