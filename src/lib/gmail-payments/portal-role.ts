export type GmailPaymentTrackRole = "manager" | "vendor";

/** Manager Zelle/Venmo receipt inboxes — each channel may use a different Gmail account. */
export type ManagerPaymentReceiptChannel = "venmo" | "zelle";

export const MANAGER_PAYMENT_RECEIPT_CHANNELS = ["venmo", "zelle"] as const satisfies readonly ManagerPaymentReceiptChannel[];

export function gmailPaymentsStorageKey(
  role: GmailPaymentTrackRole,
  channel?: ManagerPaymentReceiptChannel,
): string {
  if (role === "vendor") return "gmailPaymentsVendor";
  if (channel === "venmo") return "gmailPaymentsManagerVenmo";
  if (channel === "zelle") return "gmailPaymentsManagerZelle";
  return "gmailPaymentsManager";
}
