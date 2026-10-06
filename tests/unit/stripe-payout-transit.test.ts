import { describe, expect, it } from "vitest";
import { readPayoutTransit } from "@/lib/stripe-payouts.server";

function fixture(rows: Array<Record<string, unknown>>, cap = 100) {
  let owner = "";
  const query = {
    eq: (_column: string, value: string) => { owner = value; return query; },
    in: () => query,
    order: () => query,
    range: async (start: number, end: number) => ({
      data: rows.filter((row) => row.manager_user_id === owner)
        .slice(start, Math.min(end + 1, start + cap)), error: null,
    }),
  };
  return { from: () => ({ select: () => query }) };
}

describe("payout transit reader", () => {
  it("counts exact instant bank net, excludes unknown claims, and pages a small server cap", async () => {
    const rows = [
      { id: "1", manager_user_id: "owner", amount_cents: 10_000, fee_cents: 150,
        method: "instant", stripe_payout_id: "po_1", initiated_in_app: true,
        row_data: { inAppPayout: { version: 1, destinationId: "card_1", stripeAmountCents: 9_850 } } },
      { id: "2", manager_user_id: "owner", amount_cents: 5_000, fee_cents: 0,
        method: "standard", stripe_payout_id: null, initiated_in_app: true, row_data: {} },
      { id: "3", manager_user_id: "owner", amount_cents: 2_000, fee_cents: 0,
        method: "standard", stripe_payout_id: "po_3", initiated_in_app: false, row_data: {} },
      { id: "4", manager_user_id: "other", amount_cents: 50_000, fee_cents: 0,
        method: "standard", stripe_payout_id: "po_4", initiated_in_app: false, row_data: {} },
    ];
    await expect(readPayoutTransit(fixture(rows, 2) as never, "owner"))
      .resolves.toEqual({ onTheWayCents: 11_850, payoutReconciliationPending: true });
  });

  it("fails closed on malformed bank amount", async () => {
    await expect(readPayoutTransit(fixture([{ id: "1", manager_user_id: "owner",
      amount_cents: 100, fee_cents: null, method: "instant", stripe_payout_id: "po_1",
      initiated_in_app: true, row_data: {} }]) as never, "owner"))
      .rejects.toThrow(/invalid bank amount/);
  });
});
