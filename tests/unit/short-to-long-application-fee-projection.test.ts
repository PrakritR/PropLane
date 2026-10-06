import { describe, expect, it } from "vitest";
import { projectShortToLongTermApplicationFeeCharge, type HouseholdCharge } from "@/lib/household-charges";

const pending: HouseholdCharge = {
  id: "hc_app_application-a", createdAt: "2026-01-01T00:00:00Z", applicationId: "application-a",
  residentEmail: "resident@example.test", residentName: "Resident", residentUserId: null,
  propertyId: "property-a", propertyLabel: "Property", managerUserId: "manager-a",
  kind: "application_fee", title: "Application fee", amountLabel: "$50.00", balanceLabel: "$50.00",
  status: "pending", blocksLeaseUntilPaid: false,
};

describe("short-to-long application fee projection", () => {
  it("cancels an unpaid fee without creating receipt or waiver authority", () => {
    const projected = projectShortToLongTermApplicationFeeCharge(pending);
    expect(projected).toMatchObject({ status: "cancelled", balanceLabel: "$0.00", amountLabel: "$50.00" });
    for (const key of ["paidAt", "paidAmountCents", "paidMethod", "stripeCheckoutSessionId", "waivedAt", "waivedByUserId"]) {
      expect(projected).not.toHaveProperty(key);
    }
  });

  it("preserves exact settled and in-flight sources, including any existing waiver", () => {
    for (const source of [
      { ...pending, status: "paid" as const, paidAt: "2026-01-02T12:00:00Z", stripeCheckoutSessionId: "cs_test_a" },
      { ...pending, status: "processing" as const, stripePaymentStatus: "processing" },
      { ...pending, status: "refunded" as const, paidAt: "2026-01-02T12:00:00Z" },
      { ...pending, status: "cancelled" as const, waivedAt: "2026-01-02T12:00:00Z", waivedByUserId: "manager-a" },
    ]) expect(projectShortToLongTermApplicationFeeCharge(source)).toEqual(source);
  });

  it("does not cancel an ambiguous pending row carrying a provider source", () => {
    const source = { ...pending, stripeCheckoutSessionId: "cs_test_unverified" };
    expect(projectShortToLongTermApplicationFeeCharge(source)).toEqual(source);
  });
});
