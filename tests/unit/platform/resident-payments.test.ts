import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  availableManualChannelsForCharges,
  canPayHouseholdChargeWithManualChannel,
  chargesSupportPlatformCheckout,
  coerceResidentPaymentMethodForSurface,
  filterChargesForPayMethod,
  isPayableHouseholdCharge,
  isStripeResidentPayMethod,
  residentManualChannelsForCharges,
  residentPaymentMethodsForSurface,
  RESIDENT_NATIVE_PAYMENT_METHODS,
  RESIDENT_WEB_PAYMENT_METHODS,
} from "@/lib/platform/resident-payments";
import { readNativePlatformHeader } from "@/lib/platform/native-client";

function mkCharge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "c1",
    kind: "rent",
    title: "Rent",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    propertyId: "prop-1",
    propertyLabel: "SoMa Loft House",
    residentEmail: "resident@test.proplane.local",
    residentName: "Test Resident",
    residentUserId: "user-1",
    managerUserId: "mgr-1",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    blocksLeaseUntilPaid: false,
    ...overrides,
  };
}

describe("resident payment surface policy", () => {
  it("offers ACH, Link, and card on the web", () => {
    expect(residentPaymentMethodsForSurface(false)).toEqual(RESIDENT_WEB_PAYMENT_METHODS);
  });

  it("offers ACH and card in the native app", () => {
    expect(residentPaymentMethodsForSurface(true)).toEqual(RESIDENT_NATIVE_PAYMENT_METHODS);
  });

  it("coerces link to ACH in the native app", () => {
    expect(coerceResidentPaymentMethodForSurface("card", true)).toBe("card");
    expect(coerceResidentPaymentMethodForSurface("link", true)).toBe("ach");
    expect(coerceResidentPaymentMethodForSurface("ach", true)).toBe("ach");
  });

  it("preserves web payment method choice", () => {
    expect(coerceResidentPaymentMethodForSurface("card", false)).toBe("card");
    expect(coerceResidentPaymentMethodForSurface("link", false)).toBe("link");
  });
});

describe("manual household charge payments", () => {
  it("detects stripe vs manual pay methods", () => {
    expect(isStripeResidentPayMethod("ach")).toBe(true);
    expect(isStripeResidentPayMethod("zelle")).toBe(false);
  });

  it("allows zelle/venmo only when charge snapshots exist", () => {
    const zelleCharge = mkCharge({ zelleContactSnapshot: "pay@example.com" });
    const venmoCharge = mkCharge({ venmoContactSnapshot: "@landlord" });
    expect(canPayHouseholdChargeWithManualChannel(zelleCharge, "zelle")).toBe(true);
    expect(canPayHouseholdChargeWithManualChannel(zelleCharge, "venmo")).toBe(false);
    expect(canPayHouseholdChargeWithManualChannel(venmoCharge, "venmo")).toBe(true);
  });

  it("derives available manual channels from unpaid charges", () => {
    const charges = [
      mkCharge({ id: "a", zelleContactSnapshot: "z@x.com" }),
      mkCharge({ id: "b", venmoContactSnapshot: "@v" }),
      mkCharge({ id: "c", status: "paid", zelleContactSnapshot: "z@x.com" }),
    ];
    expect(availableManualChannelsForCharges(charges)).toEqual(["zelle", "venmo"]);
  });

  it("filters charges by selected pay method", () => {
    const charges = [
      mkCharge({ id: "ach", axisPaymentsEnabledSnapshot: true }),
      mkCharge({ id: "zelle", axisPaymentsEnabledSnapshot: false, zelleContactSnapshot: "z@x.com" }),
    ];
    expect(filterChargesForPayMethod(charges, "ach").map((c) => c.id)).toEqual(["ach"]);
    expect(filterChargesForPayMethod(charges, "zelle").map((c) => c.id)).toEqual(["zelle"]);
    expect(isPayableHouseholdCharge(charges[1]!)).toBe(true);
  });

  it("hides manual channels when platform checkout is available", () => {
    const charges = [
      mkCharge({
        id: "platform",
        axisPaymentsEnabledSnapshot: true,
        managerStripeConnectReadySnapshot: true,
        zelleContactSnapshot: "z@x.com",
      }),
    ];
    expect(chargesSupportPlatformCheckout(charges)).toBe(true);
    expect(residentManualChannelsForCharges(charges)).toEqual([]);
  });

  it("offers manual channels only when platform checkout is unavailable", () => {
    const charges = [
      mkCharge({
        id: "manual",
        axisPaymentsEnabledSnapshot: true,
        managerStripeConnectReadySnapshot: false,
        zelleContactSnapshot: "z@x.com",
      }),
    ];
    expect(chargesSupportPlatformCheckout(charges)).toBe(false);
    expect(residentManualChannelsForCharges(charges)).toEqual(["zelle"]);
  });
});

describe("native client header", () => {
  it("reads ios and android platform headers", () => {
    const ios = new Request("http://localhost", { headers: { "x-axis-native-platform": "ios" } });
    const android = new Request("http://localhost", { headers: { "x-axis-native-platform": "android" } });
    const web = new Request("http://localhost");

    expect(readNativePlatformHeader(ios)).toBe("ios");
    expect(readNativePlatformHeader(android)).toBe("android");
    expect(readNativePlatformHeader(web)).toBeNull();
  });
});
