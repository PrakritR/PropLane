import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";
import {
  COMMS_INCLUDED_ALLOWANCE_CENTS,
  commsAllowanceBlockedMessage,
  commsAllowanceFeatureText,
} from "@/lib/comms-billing/allowances";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";
import { COMPARE } from "@/components/marketing/site/pricing-compare-data";

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
      // Round 3 plan model: Free includes no credit, and its card says so as a
      // dash, not a check.
      expect(line?.included).toBe(tier.id !== "free");
    }
  });

  it("states the dollar value that the allowance table enforces", () => {
    expect(commsAllowanceFeatureText("free")).toMatch(/no communication credit/i);
    expect(commsAllowanceFeatureText("pro")).toContain("$25");
    expect(commsAllowanceFeatureText("business")).toContain("$150");
    // Rate-card values (2026-09-door-v1): $0 / $25 / $150 monthly credit.
    expect(COMMS_INCLUDED_ALLOWANCE_CENTS).toEqual({ free: 0, pro: 2500, business: 15000 });
  });

  it("the paywall copy names the amount and the way out (buy prepaid credit)", () => {
    const msg = commsAllowanceBlockedMessage("pro");
    expect(msg).toContain("$25.00");
    expect(msg).toMatch(/buy more usage/i);
    expect(msg).toMatch(/does not enable automatic charges/i);
  });

  it("the public compare table states the same three amounts, derived not retyped", () => {
    // The standalone /pricing page is gone; `COMPARE` is the one public feature table left (the home page's
    // pricing section reads it through `pickCompareRows`). The guarantee is unchanged: the amounts shown are
    // the live `COMMS_INCLUDED_ALLOWANCE_CENTS` values, formatted, never typed into the copy.
    const row = COMPARE.flatMap((group) => group.rows).find((entry) => /included credit/i.test(entry.label));
    expect(row, "the compare table should carry an included-credit row").toBeTruthy();
    expect(row!.cells).toEqual([
      formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.free!),
      formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!),
      formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.business!),
    ]);
    const source = readFileSync("src/components/marketing/site/pricing-compare-data.tsx", "utf8");
    expect(source).toContain("COMMS_INCLUDED_ALLOWANCE_CENTS");
    expect(source).not.toContain('"$25"');
    expect(source).not.toContain('"$150"');
    expect(COMMS_INCLUDED_ALLOWANCE_CENTS.free).toBe(0);
  });
});
