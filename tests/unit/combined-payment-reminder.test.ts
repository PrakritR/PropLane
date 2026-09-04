import { describe, expect, it } from "vitest";
import {
  buildCombinedPaymentReminderBody,
  sumPaymentBalanceLabels,
} from "@/lib/manual-payment-instructions";

/**
 * A resident with six outstanding charges was sent six separate reminders, one
 * per charge — the same message six times over from their side. Several charges
 * for one person now go out as one message.
 */
describe("buildCombinedPaymentReminderBody", () => {
  const CHARGES = [
    { title: "Rent — October 2026", balanceDue: "$1,125.00", dueDate: "Oct 1, 2026" },
    { title: "Utilities — October 2026", balanceDue: "$150.00", dueDate: "Oct 1, 2026" },
    { title: "Security deposit", balanceDue: "$1,050.00", dueDate: "" },
  ];

  it("itemises every charge in one message", () => {
    const body = buildCombinedPaymentReminderBody({
      residentName: "Sam Group Mate",
      charges: CHARGES,
      propertyLabel: "Ballard House",
      managerName: "Your property manager",
      totalLabel: "$2,325.00",
    });

    expect(body).toContain("Hi Sam Group Mate,");
    expect(body).toContain("you have 3 outstanding payments");
    for (const charge of CHARGES) {
      expect(body).toContain(charge.title);
      expect(body).toContain(charge.balanceDue);
    }
    expect(body).toContain("Total outstanding: $2,325.00");
    expect(body).toContain("Ballard House");
  });

  it("names a due date only where the charge has one", () => {
    const body = buildCombinedPaymentReminderBody({
      residentName: "Sam",
      charges: [{ title: "Security deposit", balanceDue: "$1,050.00", dueDate: "" }],
      propertyLabel: "Ballard House",
      managerName: "Manager",
    });
    expect(body).toContain("• Security deposit — $1,050.00");
    expect(body).not.toContain("due ");
  });
});

describe("sumPaymentBalanceLabels", () => {
  it("totals formatted balances", () => {
    expect(sumPaymentBalanceLabels(["$1,125.00", "$150.00", "$1,050.00"])).toBe("$2,325.00");
  });

  /** A total that is quietly short is worse than no total at all. */
  it("returns nothing rather than a wrong number when a label does not parse", () => {
    expect(sumPaymentBalanceLabels(["$100.00", "—"])).toBe("");
    expect(sumPaymentBalanceLabels(["$100.00", ""])).toBe("");
  });

  it("returns nothing when there is nothing owed", () => {
    expect(sumPaymentBalanceLabels(["$0.00"])).toBe("");
  });
});
