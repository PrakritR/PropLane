import { describe, expect, it } from "vitest";
import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";
import {
  availableManagerVendorPayMethods,
  defaultManagerVendorPayMethod,
  enrichOutgoingRowWithVendorPayments,
  managerCanPayOutgoingRowWithMethod,
} from "@/lib/manager-vendor-payment-flow";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

function vendor(overrides: Partial<ManagerVendorRow> = {}): ManagerVendorRow {
  return {
    id: "v1",
    managerUserId: "m1",
    name: "Ace HVAC",
    trade: "HVAC",
    phone: "",
    email: "",
    notes: "",
    active: true,
    achPaymentsEnabled: true,
    ...overrides,
  };
}

describe("manager-vendor-payment-flow", () => {
  it("derives available pay methods from vendor profile", () => {
    expect(availableManagerVendorPayMethods(vendor())).toEqual(["ach"]);
    expect(defaultManagerVendorPayMethod(vendor())).toBe("ach");
    expect(defaultManagerVendorPayMethod(vendor({ achPaymentsEnabled: false }))).toBeNull();
  });

  it("enriches outgoing rows with the vendor's payout availability", () => {
    const base: DemoManagerOutgoingPaymentRow = {
      id: "wo-1",
      propertyName: "Oak",
      categoryLabel: "Vendor payment",
      payeeLabel: "Ace HVAC",
      chargeTitle: "Fix AC",
      amountLabel: "$120.00",
      dueDate: "Jul 1",
      bucket: "pending",
      statusLabel: "Awaiting approval",
      workOrderId: "wo-1",
    };
    const enriched = enrichOutgoingRowWithVendorPayments(base, vendor());
    expect(enriched.achAvailable).toBe(true);
    expect(enriched.vendorPaymentMethods).toEqual(["ach"]);
  });

  it("gates pay actions by method availability", () => {
    const row = enrichOutgoingRowWithVendorPayments(
      {
        id: "wo-1",
        propertyName: "Oak",
        categoryLabel: "Vendor payment",
        payeeLabel: "Ace HVAC",
        chargeTitle: "Fix AC",
        amountLabel: "$120.00",
        dueDate: "Jul 1",
        bucket: "pending",
        statusLabel: "Awaiting approval",
        workOrderId: "wo-1",
      },
      vendor(),
    );
    expect(managerCanPayOutgoingRowWithMethod(row, "ach")).toBe(true);
    expect(managerCanPayOutgoingRowWithMethod({ ...row, bucket: "paid" }, "ach")).toBe(false);
    const unlinked = enrichOutgoingRowWithVendorPayments(row, vendor({ achPaymentsEnabled: false }));
    expect(managerCanPayOutgoingRowWithMethod(unlinked, "ach")).toBe(false);
  });
});
