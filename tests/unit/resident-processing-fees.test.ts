import { describe, expect, it } from "vitest";
import {
  achProcessingFeeCents,
  achPlatformRecoupCents,
  managerAbsorbedPaymentFeeCents,
  normalizeProServiceFeeChoice,
  normalizeServiceFeeChoice,
  residentProcessingFeeCents,
  residentProcessingFeeDisplayLabel,
  residentServiceFeeBreakdown,
  resolveServiceFeePayer,
  type ResidentAxisPaymentMethod,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import type { ManagerSkuTier } from "@/lib/manager-access";

// The service fee is Stripe's real per-method processing cost, passed through at
// cost. WHO pays it depends on the manager's plan (resolveServiceFeePayer):
//   Free → resident always; Pro / Business → the manager's stored choice.
// residentServiceFeeBreakdown places that fee onto the Connect destination
// charge so the resident total, the retained application fee, and the manager
// payout always reconcile.

const METHODS: ResidentAxisPaymentMethod[] = ["ach", "card", "link"];

describe("residentProcessingFeeCents — Stripe's real per-method cost", () => {
  it("card/Link are 2.9% + $0.30", () => {
    expect(residentProcessingFeeCents(100, "card")).toBe(32); // floor(2.9)=2 + 30
    expect(residentProcessingFeeCents(5_000, "card")).toBe(175); // 145 + 30
    expect(residentProcessingFeeCents(10_000, "card")).toBe(320); // 290 + 30
    expect(residentProcessingFeeCents(62_500, "link")).toBe(1_842); // floor(1812.5)=1812 + 30
  });

  it("ACH is 0.8% capped at $5.00", () => {
    expect(achProcessingFeeCents(100)).toBe(1); // round(0.8)
    expect(achProcessingFeeCents(5_000)).toBe(40);
    expect(achProcessingFeeCents(62_500)).toBe(500); // 500, at the cap
    expect(achProcessingFeeCents(200_000)).toBe(500); // capped
    expect(residentProcessingFeeCents(200_000, "ach")).toBe(500);
    expect(achPlatformRecoupCents(200_000)).toBe(500); // legacy alias
  });

  it("is 0 for non-positive subtotals", () => {
    for (const method of METHODS) {
      expect(residentProcessingFeeCents(0, method)).toBe(0);
      expect(residentProcessingFeeCents(-5, method)).toBe(0);
    }
  });

  it("discloses the real per-method rate", () => {
    expect(residentProcessingFeeDisplayLabel("ach")).toContain("0.8%");
    expect(residentProcessingFeeDisplayLabel("card")).toContain("2.9%");
    expect(residentProcessingFeeDisplayLabel("link")).toContain("2.9%");
  });
});

describe("resolveServiceFeePayer — the plan rule", () => {
  it("Free → resident always", () => {
    expect(resolveServiceFeePayer("free", "resident")).toBe("resident");
    expect(resolveServiceFeePayer("free", "manager")).toBe("resident"); // choice ignored on Free
  });

  it("Pro / Business → the manager's stored choice", () => {
    expect(resolveServiceFeePayer("pro", "resident")).toBe("resident");
    expect(resolveServiceFeePayer("pro", "manager")).toBe("manager");
    expect(resolveServiceFeePayer("pro", "proplane")).toBe("proplane");
    expect(resolveServiceFeePayer("business", "resident")).toBe("resident");
    expect(resolveServiceFeePayer("business", "manager")).toBe("manager");
    expect(resolveServiceFeePayer("business", "proplane")).toBe("proplane");
  });
});

describe("normalizeServiceFeeChoice — default resident", () => {
  it("accepts resident, manager, and proplane", () => {
    expect(normalizeServiceFeeChoice("manager")).toBe("manager");
    expect(normalizeServiceFeeChoice("resident")).toBe("resident");
    expect(normalizeServiceFeeChoice("proplane")).toBe("proplane");
    expect(normalizeServiceFeeChoice(undefined)).toBe("resident");
    expect(normalizeServiceFeeChoice(null)).toBe("resident");
    expect(normalizeServiceFeeChoice("garbage")).toBe("resident");
  });
});

describe("normalizeProServiceFeeChoice — legacy two-value helper", () => {
  it("maps proplane back to resident for older call sites", () => {
    expect(normalizeProServiceFeeChoice("proplane")).toBe("resident");
  });
});

describe("residentServiceFeeBreakdown — placement + reconciliation", () => {
  const payers: ServiceFeePayer[] = ["resident", "manager", "proplane"];
  const subtotals = [100, 5_000, 62_500, 200_000, 499_900];

  for (const method of METHODS) {
    for (const payer of payers) {
      for (const subtotal of subtotals) {
        it(`${method} @ $${(subtotal / 100).toFixed(2)} — ${payer} pays`, () => {
          const b = residentServiceFeeBreakdown(subtotal, method, payer);
          const fee = residentProcessingFeeCents(subtotal, method);

          // Universal invariant: what the payer is charged, minus what PropLane
          // retains, equals what the manager receives.
          expect(b.totalCents - b.applicationFeeCents).toBe(b.managerPayoutCents);

          if (payer === "resident") {
            expect(b.serviceFeeCents).toBe(fee);
            expect(b.residentAddedFeeCents).toBe(fee);
            expect(b.applicationFeeCents).toBe(fee);
            expect(b.managerPayoutCents).toBe(subtotal); // manager kept whole
            expect(b.totalCents).toBe(subtotal + fee); // resident pays on top
          } else if (payer === "manager") {
            expect(b.serviceFeeCents).toBe(fee);
            expect(b.residentAddedFeeCents).toBe(0); // resident pays face value
            expect(b.applicationFeeCents).toBe(fee);
            expect(b.managerPayoutCents).toBe(subtotal - fee); // manager absorbs it
            expect(b.totalCents).toBe(subtotal);
          } else {
            expect(b.serviceFeeCents).toBe(0);
            expect(b.residentAddedFeeCents).toBe(0);
            expect(b.applicationFeeCents).toBe(0); // no application fee → PropLane bears Stripe's cost
            expect(b.managerPayoutCents).toBe(subtotal); // manager kept whole
            expect(b.totalCents).toBe(subtotal); // resident pays face value
          }

          expect(Number.isInteger(b.totalCents)).toBe(true);
          expect(Number.isInteger(b.managerPayoutCents)).toBe(true);
        });
      }
    }
  }
});

describe("managerAbsorbedPaymentFeeCents", () => {
  it("is non-zero only when the manager pays", () => {
    expect(managerAbsorbedPaymentFeeCents(10_000, "card", "manager")).toBe(
      residentProcessingFeeCents(10_000, "card"),
    );
    expect(managerAbsorbedPaymentFeeCents(10_000, "card", "resident")).toBe(0);
    expect(managerAbsorbedPaymentFeeCents(10_000, "card", "proplane")).toBe(0);
  });
});

// End-to-end plan → charged amount, for every plan and the Pro setting in both
// positions. This is the acceptance table.
describe("plan → charged amount (acceptance table)", () => {
  const cases: {
    tier: ManagerSkuTier;
    choice: ServiceFeePayer;
    expected: ServiceFeePayer;
  }[] = [
    { tier: "free", choice: "resident", expected: "resident" },
    { tier: "free", choice: "manager", expected: "resident" },
    { tier: "free", choice: "proplane", expected: "resident" },
    { tier: "pro", choice: "resident", expected: "resident" },
    { tier: "pro", choice: "manager", expected: "manager" },
    { tier: "pro", choice: "proplane", expected: "proplane" },
    { tier: "business", choice: "resident", expected: "resident" },
    { tier: "business", choice: "manager", expected: "manager" },
    { tier: "business", choice: "proplane", expected: "proplane" },
  ];

  const subtotal = 200_000; // $2,000 rent
  for (const { tier, choice, expected } of cases) {
    it(`${tier}/${choice} → ${expected}`, () => {
      const payer = resolveServiceFeePayer(tier, choice);
      expect(payer).toBe(expected);
      const b = residentServiceFeeBreakdown(subtotal, "card", payer);
      const fee = residentProcessingFeeCents(subtotal, "card");
      if (expected === "resident") {
        expect(b.totalCents).toBe(subtotal + fee);
        expect(b.managerPayoutCents).toBe(subtotal);
      } else if (expected === "manager") {
        expect(b.totalCents).toBe(subtotal);
        expect(b.managerPayoutCents).toBe(subtotal - fee);
      } else {
        expect(b.totalCents).toBe(subtotal);
        expect(b.managerPayoutCents).toBe(subtotal);
        expect(b.applicationFeeCents).toBe(0);
      }
    });
  }
});
