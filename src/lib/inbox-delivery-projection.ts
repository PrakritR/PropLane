/**
 * Delivery receipts (`deliveries` on a message, `rootDeliveries` on its row) carry provider message ids and raw
 * failure reasons. They are the SENDER's operational data: the manager who sent the message sees them, nobody on the
 * receiving side of a resident / vendor conversation does, and a Team chat or House chat is read by several people
 * who are not the sender. Pure; every other field is returned untouched.
 */
export function withoutDeliveryReceipts<T extends Record<string, unknown>>(row: T): T {
  const next: Record<string, unknown> = { ...row };
  delete next.rootDeliveries;
  delete next.deliveries;
  if (Array.isArray(next.messages)) {
    next.messages = (next.messages as unknown[]).map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return message;
      const { deliveries: _deliveries, ...rest } = message as Record<string, unknown>;
      void _deliveries;
      return rest;
    });
  }
  return next as T;
}
