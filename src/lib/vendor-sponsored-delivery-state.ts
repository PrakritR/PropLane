export type VendorSponsoredChannelDelivery = "sent" | "sending" | "failed";

/** A logical message is never downgraded by a later channel result. */
export function aggregateVendorSponsoredDelivery(
  outcomes: readonly VendorSponsoredChannelDelivery[],
  previous?: VendorSponsoredChannelDelivery,
): VendorSponsoredChannelDelivery {
  if (previous === "sent" || outcomes.includes("sent")) return "sent";
  if (previous === "sending" || outcomes.includes("sending")) return "sending";
  return "failed";
}
