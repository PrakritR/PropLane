import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

/** How a vendor receives payment for completed work — ACH through Stripe Connect. */
export type VendorAcceptedPaymentMethod = "ach";

export const VENDOR_ACCEPTED_PAYMENT_METHODS: VendorAcceptedPaymentMethod[] = ["ach"];

export const VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS: Record<VendorAcceptedPaymentMethod, string> = {
  ach: "Bank (ACH)",
};

export type VendorPaymentMethodSettings = Pick<ManagerVendorRow, "achPaymentsEnabled" | "acceptedPaymentMethods">;

export function acceptedPaymentMethodsForVendor(
  row: VendorPaymentMethodSettings | null | undefined,
): VendorAcceptedPaymentMethod[] {
  const raw = row?.acceptedPaymentMethods;
  if (Array.isArray(raw) && raw.length > 0) {
    const filtered = VENDOR_ACCEPTED_PAYMENT_METHODS.filter((method) => raw.includes(method));
    if (filtered.length > 0) return filtered;
  }
  return row?.achPaymentsEnabled ? ["ach"] : [];
}

export function vendorPaymentMethodSummaryLines(row: VendorPaymentMethodSettings | null | undefined): string[] {
  return row?.achPaymentsEnabled ? ["Bank (ACH) via Stripe Connect"] : [];
}

export function vendorPaymentMethodSummaryLabel(row: VendorPaymentMethodSettings | null | undefined): string {
  const methods = acceptedPaymentMethodsForVendor(row);
  if (methods.length === 0) return "No payment methods set";
  return methods.map((method) => VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS[method]).join(", ");
}

export function buildVendorAcceptedPaymentMethods(input: { achPaymentsEnabled: boolean }): VendorAcceptedPaymentMethod[] {
  return input.achPaymentsEnabled ? ["ach"] : [];
}
