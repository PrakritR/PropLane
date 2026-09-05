/**
 * Who pays Stripe's processing fee.
 *
 * Three parties can end up holding it and the money genuinely moves differently for each: the
 * resident pays it on top (the manager still nets the subtotal), the manager absorbs it out of
 * their proceeds, or PropLane absorbs it so neither of them is charged at all.
 *
 * The setting can be recorded in three places — PropLane staff on a manager's account, the
 * manager per property in Pricing, and the manager's account-wide default — so the value of this
 * module is the precedence between them, and the two things it refuses.
 */
import { describe, expect, it } from "vitest";
import {
  residentServiceFeeBreakdown,
  resolveServiceFeePayerFor,
  type ServiceFeePayer,
} from "@/lib/payment-policy";

const payer = (over: Partial<Parameters<typeof resolveServiceFeePayerFor>[0]> = {}) =>
  resolveServiceFeePayerFor({ tier: "pro", ...over });

describe("precedence", () => {
  it("AXI-149: a paid plan defaults to PropLane absorbing the fee", () => {
    // "PropLane takes all processing fees for paid accounts." A manager who is
    // paying for the product does not additionally hand Stripe's cost to their
    // residents by default.
    expect(payer()).toBe("proplane");
    expect(resolveServiceFeePayerFor({ tier: "business" })).toBe("proplane");
  });

  it("Free still defaults to the resident — absorbing fees is a paid capability", () => {
    expect(resolveServiceFeePayerFor({ tier: "free" })).toBe("resident");
  });

  it("an explicit choice still beats the paid-plan default", () => {
    // A manager who deliberately passes the fee on must not silently stop.
    expect(payer({ managerChoice: "resident" })).toBe("resident");
    expect(payer({ managerChoice: "proplane", propertyChoice: "resident" })).toBe("resident");
  });

  it("uses the manager's account default when the property says nothing", () => {
    expect(payer({ managerChoice: "manager" })).toBe("manager");
  });

  it("lets one property differ from the account default", () => {
    // A manager absorbing fees in one building and not another is a real arrangement.
    expect(payer({ managerChoice: "manager", propertyChoice: "resident" })).toBe("resident");
    expect(payer({ managerChoice: "resident", propertyChoice: "manager" })).toBe("manager");
  });

  it("lets staff override both", () => {
    expect(payer({ adminOverride: "manager", propertyChoice: "resident", managerChoice: "resident" })).toBe(
      "manager",
    );
  });
});

describe("the plan floor", () => {
  it("keeps a free-tier manager from shifting the fee onto themselves", () => {
    // Absorbing fees is a paid capability.
    expect(resolveServiceFeePayerFor({ tier: "free", managerChoice: "manager" })).toBe("resident");
    expect(resolveServiceFeePayerFor({ tier: "free", propertyChoice: "manager" })).toBe("resident");
  });

  it("still lets staff absorb a free-tier manager's fees", () => {
    // That is the entire point of the staff control — it must not be blocked by the plan.
    expect(resolveServiceFeePayerFor({ tier: "free", adminOverride: "proplane" })).toBe("proplane");
  });
});

describe("what a manager cannot do to themselves", () => {
  it("honours proplane on Free when the account has a payment-waiver grant", () => {
    expect(resolveServiceFeePayerFor({ tier: "free", propertyChoice: "proplane", waiverGranted: true })).toBe(
      "proplane",
    );
    expect(resolveServiceFeePayerFor({ tier: "free", managerChoice: "proplane", waiverGranted: true })).toBe(
      "proplane",
    );
  });

  it("ignores a proplane value on Free without a waiver grant", () => {
    // Honouring it there would let a free manager stop paying fees by writing one
    // word into their own record, with PropLane picking up the bill.
    expect(resolveServiceFeePayerFor({ tier: "free", propertyChoice: "proplane" })).toBe("resident");
    expect(resolveServiceFeePayerFor({ tier: "free", managerChoice: "proplane" })).toBe("resident");
  });

  it("honours it on every PAID plan, where absorbing the fee is what the plan does", () => {
    expect(resolveServiceFeePayerFor({ tier: "pro", managerChoice: "proplane" })).toBe("proplane");
    expect(resolveServiceFeePayerFor({ tier: "business", managerChoice: "proplane" })).toBe("proplane");
    expect(resolveServiceFeePayerFor({ tier: "business", propertyChoice: "proplane" })).toBe("proplane");
  });

  it("still honours proplane from staff, who are the ones spending PropLane's money", () => {
    expect(payer({ adminOverride: "proplane" })).toBe("proplane");
  });

  it("falls back to the plan rule rather than to whatever was written", () => {
    expect(
      resolveServiceFeePayerFor({
        tier: "free",
        managerChoice: "proplane" as ServiceFeePayer,
        propertyChoice: null,
      }),
    ).toBe("resident");
  });
});

describe("what each answer costs whom", () => {
  const subtotal = 100_000; // $1,000 rent

  it("adds the fee on top when the resident pays, leaving the manager whole", () => {
    const bill = residentServiceFeeBreakdown(subtotal, "card", "resident");
    expect(bill.residentAddedFeeCents).toBeGreaterThan(0);
    expect(bill.applicationFeeCents).toBe(bill.serviceFeeCents);
  });

  it("takes it out of the manager's proceeds when the manager pays", () => {
    const bill = residentServiceFeeBreakdown(subtotal, "card", "manager");
    expect(bill.residentAddedFeeCents).toBe(0);
    expect(bill.applicationFeeCents).toBe(bill.serviceFeeCents);
  });

  it("charges neither of them when PropLane absorbs it", () => {
    // The distinguishing property of the staff override: nothing is added to the resident AND
    // nothing is retained from the manager, so the cost lands on PropLane's own account.
    const bill = residentServiceFeeBreakdown(subtotal, "card", "proplane");
    expect(bill.residentAddedFeeCents).toBe(0);
    expect(bill.applicationFeeCents).toBe(0);
  });
});
