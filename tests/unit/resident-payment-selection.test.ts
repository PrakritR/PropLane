import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  chargeBalanceCents,
  encodeSelectedChargeIds,
  parseSelectedChargeIds,
  pendingChargesTotalCents,
  residentPaymentsHrefWithSelection,
  selectAllUnpaidAchChargeIds,
  unpaidPayableChargesForResident,
  selectAllUnpaidPayableChargeIds,
  toggleChargeSelection,
  unpaidAchChargesForResident,
} from "@/lib/resident-payment-selection";

function mkCharge(id: string, status: HouseholdCharge["status"] = "pending"): HouseholdCharge {
  return {
    id,
    kind: "rent",
    title: "Rent",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    propertyId: "prop-1",
    propertyLabel: "SoMa Loft House",
    residentEmail: "resident@test.proplane.local",
    residentName: "Test Resident",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    axisPaymentsEnabledSnapshot: true,
  };
}

describe("resident payment selection", () => {
  it("filters unpaid ACH-payable charges", () => {
    const charges = [
      mkCharge("a"),
      mkCharge("b", "paid"),
      { ...mkCharge("c"), axisPaymentsEnabledSnapshot: false },
    ];
    expect(unpaidAchChargesForResident(charges).map((c) => c.id)).toEqual(["a"]);
  });

  it("EXCLUDES charges whose listing has PropLane payments off — checkout is Stripe-only", () => {
    // Off-platform channels were removed (PLAN-0916); a charge the listing cannot
    // take online must not land in a selection the resident cannot check out.
    const charges = [mkCharge("a"), { ...mkCharge("b"), axisPaymentsEnabledSnapshot: false }];
    expect(unpaidPayableChargesForResident(charges).map((c) => c.id)).toEqual(["a"]);
    expect(selectAllUnpaidPayableChargeIds(charges)).toEqual(new Set(["a"]));
  });

  it("toggles and selects all unpaid ACH charges", () => {
    const charges = [mkCharge("a"), mkCharge("b")];
    expect(toggleChargeSelection(new Set(), "a")).toEqual(new Set(["a"]));
    expect(toggleChargeSelection(new Set(["a"]), "a")).toEqual(new Set());
    expect(selectAllUnpaidAchChargeIds(charges)).toEqual(new Set(["a", "b"]));
  });

  it("parses selected ids against allowed unpaid payable charges", () => {
    const charges = [
      mkCharge("a"),
      { ...mkCharge("b"), axisPaymentsEnabledSnapshot: false },
      mkCharge("c", "paid"),
    ];
    expect(parseSelectedChargeIds("a,c,bogus", charges)).toEqual(new Set(["a"]));
    // "b" is not payable online, so a URL that names it must not smuggle it back
    // into the selection.
    expect(parseSelectedChargeIds("b,a", charges)).toEqual(new Set(["a"]));
    expect(encodeSelectedChargeIds(["b", "a"])).toBe("b,a");
  });

  it("builds payments href and totals", () => {
    const charges = [mkCharge("a"), { ...mkCharge("b"), balanceLabel: "$50.00" }];
    expect(chargeBalanceCents("$2,500.00")).toBe(250000);
    expect(pendingChargesTotalCents(charges)).toBe(15000);
    expect(residentPaymentsHrefWithSelection(["a", "b"])).toBe("/resident/payments?selected=a%2Cb");
    expect(residentPaymentsHrefWithSelection([])).toBe("/resident/payments");
  });
});
