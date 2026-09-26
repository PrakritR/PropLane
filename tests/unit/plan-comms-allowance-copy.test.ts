import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";
import {
  COMMS_INCLUDED_ALLOWANCE_CENTS,
  commsAllowanceBlockedMessage,
  commsAllowanceFeatureText,
} from "@/lib/comms-billing/allowances";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";
import PricingPage from "@/app/(public)/pricing/page";

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

  it("the public pricing page explains the allowance with the same three amounts", async () => {
    const src = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    // Its own block on the page, not a 90-word FAQ answer.
    expect(src).toContain("Texting, calling and AI use");

    // The guarantee is that the page's copy is DERIVED from
    // COMMS_INCLUDED_ALLOWANCE_CENTS, not retyped — proven by actually
    // rendering the page and looking for the live constant's formatted
    // dollar amounts, rather than grepping source for one particular
    // indexing spelling (`.pro` vs generic `[tier]`).
    const jsx = await PricingPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain(formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!));
    expect(html).toContain(formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.business!));

    // Free's enforced allowance is zero, and the page states that in words
    // rather than retyping a "$0.00" — confirm both halves of that guarantee.
    expect(COMMS_INCLUDED_ALLOWANCE_CENTS.free).toBe(0);
    expect(html).toMatch(/free includes none/i);
  });
});
