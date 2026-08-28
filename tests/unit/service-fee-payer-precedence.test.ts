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
  it("defaults to the resident when nothing is set anywhere", () => {
    expect(payer()).toBe("resident");
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
  it("ignores a proplane value written into a manager or property field", () => {
    // The settings UI never offers it. Honouring it would let a manager stop paying fees by
    // writing one word into their own record — PropLane would silently pick up the bill.
    expect(payer({ managerChoice: "proplane" as ServiceFeePayer })).toBe("resident");
    expect(payer({ propertyChoice: "proplane" as ServiceFeePayer })).toBe("resident");
  });

  it("still honours proplane from staff, who are the ones spending PropLane's money", () => {
    expect(payer({ adminOverride: "proplane" })).toBe("proplane");
  });

  it("falls back to the plan rule rather than to whatever was written", () => {
    // A manager who set "manager" and then had "proplane" written in should land on their own
    // legitimate choice's rule, not be handed the platform's wallet.
    expect(payer({ managerChoice: "proplane" as ServiceFeePayer, propertyChoice: null })).toBe("resident");
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
