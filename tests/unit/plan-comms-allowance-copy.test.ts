import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";
import {
  COMMS_INCLUDED_ALLOWANCE_CENTS,
  commsAllowanceBlockedMessage,
  commsAllowanceFeatureText,
} from "@/lib/comms-billing/allowances";

/**
 * PRP-282: what a plan includes for texting, calling and the assistant is
 * stated on the pricing cards, and the number stated is the number enforced —
 * the copy is derived from `COMMS_INCLUDED_ALLOWANCE_CENTS`, never typed in.
 */
describe("plan communication allowance copy (PRP-282)", () => {
  it("every tier card carries its included-allowance line, derived from the enforced value", () => {
    for (const tier of MANAGER_PLAN_TIERS) {
      const expected = commsAllowanceFeatureText(tier.id);
      const line = tier.features.find((f) => f.text === expected);
      expect(line, `${tier.id} card should say "${expected}"`).toBeTruthy();
      expect(line?.included).toBe(true);
    }
  });

  it("states the dollar value that the allowance table enforces", () => {
    expect(commsAllowanceFeatureText("free")).toContain("$2.50");
    expect(commsAllowanceFeatureText("pro")).toContain("$15");
    expect(commsAllowanceFeatureText("business")).toContain("$150");
    expect(COMMS_INCLUDED_ALLOWANCE_CENTS).toEqual({ free: 250, pro: 1500, business: 15000 });
  });

  it("the paywall copy names the amount and the way out (add a card, pay as you go)", () => {
    const msg = commsAllowanceBlockedMessage("pro");
    expect(msg).toContain("$15.00");
    expect(msg).toMatch(/add a card/i);
    expect(msg).toMatch(/billed as you go/i);
  });

  it("the public pricing FAQ answers the allowance question with the same three amounts", () => {
    const src = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    expect(src).toContain("How much texting, calling and AI assistant use is included?");
    for (const amount of ["$2.50", "$15", "$150"]) expect(src).toContain(amount);
  });
});
