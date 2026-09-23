import { describe, expect, it } from "vitest";
import { commsPlanBudgetForTier } from "@/lib/comms-billing/wallet.server";
import { COMMS_INCLUDED_ALLOWANCE_CENTS } from "@/lib/comms-billing/allowances";

/**
 * PLAN-0920-1400: the one-month migration grace that let an existing manager
 * keep a HIGHER legacy allowance has ended. `legacy` must now equal the
 * plan's own included allowance for every tier, so
 * `greatest(allowance, legacy)` in `comms_wallet_snapshot` is a no-op and a
 * Business account always resolves its CURRENT rate-card credit — never a
 * stale migration-era figure, whatever that figure happened to be.
 *
 * Rate-card values (2026-09-door-v1): Business's included credit is $150 —
 * this test pins the mechanism (current plan allowance always wins), not any
 * particular dollar figure, since a later rate-card version could coincide
 * with or differ from an old migration number either way.
 */
describe("communication credit legacy allowance", () => {
  it("equals the plan's own included allowance for every tier", () => {
    for (const tier of ["free", "pro", "business"] as const) {
      const budget = commsPlanBudgetForTier(tier);
      expect(budget.legacy).toBe(COMMS_INCLUDED_ALLOWANCE_CENTS[tier]);
    }
  });

  it("a Business account resolves exactly its current $150.00 rate-card credit, with no separate legacy override", () => {
    const budget = commsPlanBudgetForTier("business");
    expect(budget.allowance).toBe(15_000);
    expect(budget.legacy).toBe(15_000);
    expect(Math.max(budget.allowance, budget.legacy)).toBe(15_000);
  });

  it("Free carries no legacy grant either", () => {
    expect(commsPlanBudgetForTier("free").legacy).toBe(0);
  });
});
