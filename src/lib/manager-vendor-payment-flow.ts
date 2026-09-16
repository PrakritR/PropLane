import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import {
  acceptedPaymentMethodsForVendor,
  VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS,
  type VendorAcceptedPaymentMethod,
} from "@/lib/vendor-payment-methods";

/** How a manager pays a vendor for an outgoing vendor payment. */
export type ManagerVendorPayMethod = VendorAcceptedPaymentMethod;

export const MANAGER_VENDOR_PAY_METHOD_OPTIONS: {
  id: ManagerVendorPayMethod;
  title: string;
  feeLabel: string;
}[] = [
  { id: "ach", title: "Bank (ACH)", feeLabel: "Pay through PropLane · Stripe Connect" },
];

/**
 * Label for a payout channel. A stored work order may still name a channel the
 * product no longer offers (paid before PLAN-0916); those read as a plain
 * "PropLane" payout rather than as `undefined`.
 */
export function managerVendorPayMethodLabel(method: ManagerVendorPayMethod | string): string {
  return (VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? "Recorded by hand";
}

export function availableManagerVendorPayMethods(
  vendor: ManagerVendorRow | null | undefined,
): ManagerVendorPayMethod[] {
  return acceptedPaymentMethodsForVendor(vendor);
}

export function defaultManagerVendorPayMethod(
  vendor: ManagerVendorRow | null | undefined,
): ManagerVendorPayMethod | null {
  const methods = availableManagerVendorPayMethods(vendor);
  if (methods.includes("ach")) return "ach";
  return methods[0] ?? null;
}

export function enrichOutgoingRowWithVendorPayments(
  row: DemoManagerOutgoingPaymentRow,
  vendor: ManagerVendorRow | null | undefined,
): DemoManagerOutgoingPaymentRow {
  if (!vendor || !row.workOrderId) return row;
  const methods = availableManagerVendorPayMethods(vendor);
  return {
    ...row,
    vendorId: vendor.id,
    vendorPaymentMethods: methods,
    achAvailable: methods.includes("ach"),
  };
}

export function managerCanPayOutgoingRowWithMethod(
  row: DemoManagerOutgoingPaymentRow,
  method: ManagerVendorPayMethod,
): boolean {
  if (row.bucket === "paid" || !row.workOrderId) return false;
  return row.vendorPaymentMethods?.includes(method) ?? false;
}
