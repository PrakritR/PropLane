import { describe, expect, it } from "vitest";
import {
  acceptedPaymentMethodsForVendor,
  buildVendorAcceptedPaymentMethods,
  vendorPaymentMethodSummaryLabel,
  vendorPaymentMethodSummaryLines,
} from "@/lib/vendor-payment-methods";

describe("vendor payment methods (ACH through Stripe Connect only)", () => {
  it("derives accepted methods from the ACH toggle", () => {
    expect(acceptedPaymentMethodsForVendor({ achPaymentsEnabled: true })).toEqual(["ach"]);
    expect(acceptedPaymentMethodsForVendor({ achPaymentsEnabled: false })).toEqual([]);
  });

  it("ignores retired methods a stored row may still list", () => {
    expect(
      acceptedPaymentMethodsForVendor({
        acceptedPaymentMethods: ["venmo", "zelle"] as unknown as "ach"[],
        achPaymentsEnabled: true,
      }),
    ).toEqual(["ach"]);
  });

  it("builds summary lines for reminders", () => {
    expect(vendorPaymentMethodSummaryLines({ achPaymentsEnabled: true })).toEqual(["Bank (ACH) via Stripe Connect"]);
    expect(vendorPaymentMethodSummaryLines({ achPaymentsEnabled: false })).toEqual([]);
  });

  it("builds accepted methods array for save payloads", () => {
    expect(buildVendorAcceptedPaymentMethods({ achPaymentsEnabled: true })).toEqual(["ach"]);
    expect(buildVendorAcceptedPaymentMethods({ achPaymentsEnabled: false })).toEqual([]);
  });

  it("labels unset methods", () => {
    expect(vendorPaymentMethodSummaryLabel(null)).toBe("No payment methods set");
    expect(vendorPaymentMethodSummaryLabel({ achPaymentsEnabled: true })).toBe("Bank (ACH)");
  });
});
