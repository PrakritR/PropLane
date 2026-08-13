import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
  normalizeManagerManualPaymentSettings,
} from "@/lib/manager-manual-payment-settings";
import {
  residentServiceFeeBreakdown,
  resolveServiceFeePayer,
  residentProcessingFeeCents,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import type { ManagerSkuTier } from "@/lib/manager-access";

describe("manager payment settings — serviceFeePayer field", () => {
  it("defaults to resident (upgrading to Pro never silently charges the manager)", () => {
    expect(DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS.serviceFeePayer).toBe("resident");
    expect(normalizeManagerManualPaymentSettings({}).serviceFeePayer).toBe("resident");
    expect(normalizeManagerManualPaymentSettings(null).serviceFeePayer).toBe("resident");
    expect(normalizeManagerManualPaymentSettings({ serviceFeePayer: "bogus" }).serviceFeePayer).toBe("resident");
  });

  it("round-trips an explicit manager or PropLane choice", () => {
    expect(normalizeManagerManualPaymentSettings({ serviceFeePayer: "manager" }).serviceFeePayer).toBe("manager");
    expect(normalizeManagerManualPaymentSettings({ serviceFeePayer: "resident" }).serviceFeePayer).toBe("resident");
    expect(normalizeManagerManualPaymentSettings({ serviceFeePayer: "proplane" }).serviceFeePayer).toBe("proplane");
  });

  it("does not disturb the other manual-payment fields", () => {
    const s = normalizeManagerManualPaymentSettings({
      serviceFeePayer: "manager",
      zellePaymentsEnabled: true,
      zelleContact: "pay@me.test",
    });
    expect(s.serviceFeePayer).toBe("manager");
    expect(s.zellePaymentsEnabled).toBe(true);
    expect(s.zelleContact).toBe("pay@me.test");
  });
});

// The payer is resolved LIVE at charge time from the manager's current tier +
// setting — nothing is persisted per charge — so a plan change or a toggle flip
// takes effect on the very next charge. These model those transitions and assert
// the fee treatment for a $2,000 card rent payment ($2,000 + $58.30 card fee).
describe("plan transitions change who is charged on the next payment", () => {
  const subtotal = 200_000;
  const fee = residentProcessingFeeCents(subtotal, "card");

  function chargeFor(tier: ManagerSkuTier, choice: ServiceFeePayer) {
    return residentServiceFeeBreakdown(subtotal, "card", resolveServiceFeePayer(tier, choice));
  }

  it("Business (PropLane pays) → Pro (resident): the fee starts being charged", () => {
    const before = chargeFor("business", "proplane");
    expect(before.totalCents).toBe(subtotal); // PropLane absorbed
    expect(before.applicationFeeCents).toBe(0);

    const after = chargeFor("pro", "resident");
    expect(after.totalCents).toBe(subtotal + fee); // resident now pays the fee
    expect(after.managerPayoutCents).toBe(subtotal);
  });

  it("Business → Free: the resident starts paying (Free forces it)", () => {
    const after = chargeFor("free", "manager"); // even a stale 'manager' choice is ignored
    expect(after.totalCents).toBe(subtotal + fee);
    expect(after.managerPayoutCents).toBe(subtotal);
  });

  it("Pro(manager pays) → Free: the manager stops absorbing; the resident pays", () => {
    const before = chargeFor("pro", "manager");
    expect(before.totalCents).toBe(subtotal); // resident face value
    expect(before.managerPayoutCents).toBe(subtotal - fee); // manager absorbed

    const after = chargeFor("free", "manager");
    expect(after.totalCents).toBe(subtotal + fee); // resident now pays
    expect(after.managerPayoutCents).toBe(subtotal);
  });

  it("Pro → Business (PropLane pays): the fee stops entirely", () => {
    const before = chargeFor("pro", "resident");
    expect(before.totalCents).toBe(subtotal + fee);

    const after = chargeFor("business", "proplane");
    expect(after.totalCents).toBe(subtotal);
    expect(after.applicationFeeCents).toBe(0);
    expect(after.managerPayoutCents).toBe(subtotal);
  });

  it("Pro toggle flip resident→manager: same resident total shifts the cost to the manager", () => {
    const residentPays = chargeFor("pro", "resident");
    const managerPays = chargeFor("pro", "manager");
    // Resident's out-of-pocket drops back to face value…
    expect(residentPays.totalCents).toBe(subtotal + fee);
    expect(managerPays.totalCents).toBe(subtotal);
    // …and the cost moves onto the manager's payout instead.
    expect(residentPays.managerPayoutCents).toBe(subtotal);
    expect(managerPays.managerPayoutCents).toBe(subtotal - fee);
  });
});
