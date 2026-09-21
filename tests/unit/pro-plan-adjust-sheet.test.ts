import { describe, expect, it } from "vitest";
import { planAdjustTransitionFact } from "@/components/portal/pro-plan-adjust-sheet";

describe("Adjust plan sheet transition facts", () => {
  it("Monthly→Annual applies today, prorated", () => {
    expect(planAdjustTransitionFact("pro", "monthly", "pro", "annual", "October 1, 2026")).toBe(
      "Annual applies today · prorated",
    );
  });

  it("Annual→Monthly is Monthly from the renewal date", () => {
    expect(planAdjustTransitionFact("pro", "annual", "pro", "monthly", "October 1, 2026")).toBe(
      "Monthly from October 1, 2026",
    );
  });

  it("Business→Pro is Pro from the renewal date, regardless of the requested billing", () => {
    expect(planAdjustTransitionFact("business", "monthly", "pro", "monthly", "October 1, 2026")).toBe(
      "Pro from October 1, 2026",
    );
    expect(planAdjustTransitionFact("business", "annual", "pro", "annual", "October 1, 2026")).toBe(
      "Pro from October 1, 2026",
    );
  });

  it("an upgrade (Pro→Business) applies today, prorated", () => {
    expect(planAdjustTransitionFact("pro", "monthly", "business", "monthly", "October 1, 2026")).toBe(
      "Business today · prorated",
    );
  });

  it("no change selected has no fact", () => {
    expect(planAdjustTransitionFact("pro", "monthly", "pro", "monthly", "October 1, 2026")).toBeNull();
  });

  it("falls back to plain renewal language when the period end is unknown", () => {
    expect(planAdjustTransitionFact("business", "monthly", "pro", "monthly", null)).toBe(
      "Pro at your next renewal",
    );
  });
});
