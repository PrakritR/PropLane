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
    expect(commsAllowanceFeatureText("free")).toContain("$2");
    expect(commsAllowanceFeatureText("pro")).toContain("$10");
    expect(commsAllowanceFeatureText("business")).toContain("$100");
    expect(COMMS_INCLUDED_ALLOWANCE_CENTS).toEqual({ free: 200, pro: 1000, business: 10000 });
  });

  it("the paywall copy names the amount and the way out (buy prepaid credit)", () => {
    const msg = commsAllowanceBlockedMessage("pro");
    expect(msg).toContain("$10.00");
    expect(msg).toMatch(/buy more usage/i);
    expect(msg).toMatch(/does not enable automatic charges/i);
  });

  it("the public pricing page explains the allowance with the same three amounts", () => {
    const src = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    // Its own block on the page, not a 90-word FAQ answer.
    expect(src).toContain("Texting, calling and AI use");
    for (const tier of ["free", "pro", "business"]) expect(src).toContain(`COMMS_INCLUDED_ALLOWANCE_CENTS.${tier}`);
  });
});
