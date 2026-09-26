import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import {
  acceptedPaymentMethodsForVendor,
  VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS,
  type VendorAcceptedPaymentMethod,
} from "@/lib/vendor-payment-methods";

/**
 * How a manager pays a vendor for an outgoing vendor payment. `"balance"`
 * (C098) pays instantly out of the manager's PropLane balance instead of
 * starting a Stripe Checkout session — it is a MANAGER-side funding choice,
 * not one of the vendor's own accepted `VendorAcceptedPaymentMethod`s, so it
 * is added on top rather than folded into that type.
 */
export type ManagerVendorPayMethod = VendorAcceptedPaymentMethod | "balance";

export const MANAGER_VENDOR_PAY_METHOD_OPTIONS: {
  id: ManagerVendorPayMethod;
  title: string;
  feeLabel: string;
}[] = [
  { id: "balance", title: "PropLane balance", feeLabel: "Instant · falls back to ACH if the balance is short" },
  { id: "ach", title: "Bank (ACH)", feeLabel: "Pay through PropLane · Stripe Connect" },
];

/**
 * Label for a payout channel. A stored work order may still name a channel the
 * product no longer offers (paid before PLAN-0916); those read as a plain
 * "PropLane" payout rather than as `undefined`.
 */
export function managerVendorPayMethodLabel(method: ManagerVendorPayMethod | string): string {
  // night/vendor-pay: paid instantly from the manager's PropLane balance —
  // not a `VendorAcceptedPaymentMethod` (that type is what a VENDOR accepts),
  // so it is handled here rather than added to that lookup.
  if (method === "balance") return "PropLane balance";
  return (VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? "Recorded by hand";
}

export function availableManagerVendorPayMethods(
  vendor: ManagerVendorRow | null | undefined,
): VendorAcceptedPaymentMethod[] {
  return acceptedPaymentMethodsForVendor(vendor);
}

/**
 * `availableManagerVendorPayMethods` plus `"balance"` when the caller has
 * already resolved it eligible (C098: `WORKSPACE_CONNECT_ENABLED` on, and the
 * PropLane balance itself enabled and read). Balance is not one of the
 * vendor's own accepted methods, so it is prepended rather than filtered by
 * `acceptedPaymentMethodsForVendor` — the manager's own balance pays the
 * vendor regardless of which rails that vendor separately accepts from Stripe.
 */
export function managerVendorPayMethodsWithBalance(
  vendor: ManagerVendorRow | null | undefined,
  balanceEligible: boolean,
): ManagerVendorPayMethod[] {
  const methods = availableManagerVendorPayMethods(vendor);
  return balanceEligible ? ["balance", ...methods] : methods;
}

export function defaultManagerVendorPayMethod(
  vendor: ManagerVendorRow | null | undefined,
  balanceEligible = false,
): ManagerVendorPayMethod | null {
  if (balanceEligible) return "balance";
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
  balanceEligible = false,
): boolean {
  if (row.bucket === "paid" || !row.workOrderId) return false;
  if (method === "balance") return balanceEligible;
  return row.vendorPaymentMethods?.includes(method) ?? false;
}
