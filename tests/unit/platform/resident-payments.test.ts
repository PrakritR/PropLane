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

describe("household charge payments (Stripe only)", () => {
  it("detects stripe pay methods", () => {
    expect(isStripeResidentPayMethod("ach")).toBe(true);
    expect(isStripeResidentPayMethod("zelle")).toBe(false);
  });

  it("never offers manual zelle/venmo channels", () => {
    const charges = [
      mkCharge({ id: "a", zelleContactSnapshot: "z@x.com" }),
      mkCharge({ id: "b", venmoContactSnapshot: "@v" }),
    ];
    expect(availableManualChannelsForCharges(charges)).toEqual([]);
    expect(residentManualChannelsForCharges(charges)).toEqual([]);
  });

  it("filters charges for Stripe ACH checkout only", () => {
    const charges = [
      mkCharge({ id: "ach", axisPaymentsEnabledSnapshot: true, managerStripeConnectReadySnapshot: true }),
      mkCharge({ id: "zelle", axisPaymentsEnabledSnapshot: false, zelleContactSnapshot: "z@x.com" }),
    ];
    expect(filterChargesForPayMethod(charges, "ach").map((c) => c.id)).toEqual(["ach"]);
    expect(isPayableHouseholdCharge(charges[1]!)).toBe(false);
  });

  it("detects when platform checkout is available", () => {
    const charges = [
      mkCharge({
        id: "platform",
        axisPaymentsEnabledSnapshot: true,
        managerStripeConnectReadySnapshot: true,
      }),
    ];
    expect(chargesSupportPlatformCheckout(charges)).toBe(true);
    expect(residentManualChannelsForCharges(charges)).toEqual([]);
  });

  it("does not fall back to manual channels when Stripe is unavailable", () => {
    const charges = [
      mkCharge({
        id: "blocked",
        axisPaymentsEnabledSnapshot: true,
        managerStripeConnectReadySnapshot: false,
        zelleContactSnapshot: "z@x.com",
      }),
    ];
    expect(chargesSupportPlatformCheckout(charges)).toBe(false);
    expect(residentManualChannelsForCharges(charges)).toEqual([]);
    expect(isPayableHouseholdCharge(charges[0]!)).toBe(false);
  });

  it("keeps legacy manual-channel helper for historical snapshots", () => {
    const zelleCharge = mkCharge({ zelleContactSnapshot: "pay@example.com" });
    expect(canPayHouseholdChargeWithManualChannel(zelleCharge, "zelle")).toBe(true);
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
