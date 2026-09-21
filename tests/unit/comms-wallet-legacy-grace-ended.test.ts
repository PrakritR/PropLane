import { describe, expect, it } from "vitest";
import { commsPlanBudgetForTier } from "@/lib/comms-billing/wallet.server";
import { COMMS_INCLUDED_ALLOWANCE_CENTS } from "@/lib/comms-billing/allowances";

/**
 * PLAN-0920-1400: the one-month migration grace that let an existing manager
 * keep a HIGHER legacy allowance has ended. `legacy` must now equal the
 * plan's own included allowance for every tier, so
 * `greatest(allowance, legacy)` in `comms_wallet_snapshot` is a no-op and a
 * Business account in the cutover month resolves exactly $100.00 — never the
 * old $150 migration allowance.
 */
describe("communication credit legacy allowance", () => {
  it("equals the plan's own included allowance for every tier", () => {
    for (const tier of ["free", "pro", "business"] as const) {
      const budget = commsPlanBudgetForTier(tier);
      expect(budget.legacy).toBe(COMMS_INCLUDED_ALLOWANCE_CENTS[tier]);
    }
  });

  it("a Business account resolves exactly $100.00, never the old $150 migration allowance", () => {
    const budget = commsPlanBudgetForTier("business");
    expect(budget.allowance).toBe(10_000);
    expect(budget.legacy).toBe(10_000);
    expect(Math.max(budget.allowance, budget.legacy)).toBe(10_000);
  });

  it("Free carries no legacy grant either", () => {
    expect(commsPlanBudgetForTier("free").legacy).toBe(0);
  });
});
