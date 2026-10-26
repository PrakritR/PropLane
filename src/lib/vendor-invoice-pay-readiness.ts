/**
 * Whether the vendor on an invoice can be paid out right now: transfers active AND
 * payouts enabled on their connected account - the same predicate as the vendor status
 * route's `paymentReady` (`connectAccountReadyForAchPayouts`). A manager may still pay
 * an unready vendor; the money is held and released when they connect.
 */
export function vendorReadyForInvoicePayout(account: {
  payouts_enabled?: boolean | null;
  capabilities?: { transfers?: string | null } | null;
} | null | undefined): boolean {
  return Boolean(account && account.capabilities?.transfers === "active" && account.payouts_enabled);
}

/** The ONE inline warning on the pay sheet; null when the vendor is ready or readiness is unknown. */
export function vendorBankNotConnectedLine(vendorName: string, vendorPayoutsReady: boolean | undefined): string | null {
  if (vendorPayoutsReady !== false) return null;
  const name = vendorName.trim() || "This vendor";
  return `${name} hasn't connected a bank yet. You're charged now; they're paid when they connect.`;
}

/** The manager's real Outgoing list: where Stripe's return_url lands, with no redirect on the way. */
export const VENDOR_INVOICE_PAY_RETURN_PATH = "/portal/outgoing/paid";

/** The vendor's name as this manager knows them: their roster entry, else the profile's name, else the business name. */
export function vendorDirectoryName(input: { rosterName?: unknown; fullName?: unknown; businessName?: unknown }): string {
  for (const value of [input.rosterName, input.fullName, input.businessName]) {
    const name = typeof value === "string" ? value.trim() : "";
    if (name && name !== "__vendor_category_settings__") return name;
  }
  return "Vendor";
}
