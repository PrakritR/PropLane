import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { deriveFeedBalances, type FeedStatement } from "@/lib/plaid/statement-balances.server";

function st(id: string, lineSumCents: number, extra: Partial<FeedStatement> = {}): FeedStatement {
  return { id, statementDate: "2026-11-30", reconciled: false, feedOwned: true, lineSumCents, openingBalanceCents: 0, closingBalanceCents: 0, ...extra };
}

describe("deriveFeedBalances", () => {
  it("walks back from the current balance, newest month first", () => {
    const updates = deriveFeedBalances([st("nov", -10_000), st("oct", 25_000)], 100_000);
    expect(updates).toEqual([
      { id: "nov", openingBalanceCents: 110_000, closingBalanceCents: 100_000 },
      { id: "oct", openingBalanceCents: 85_000, closingBalanceCents: 110_000 },
    ]);
  });

  it("never touches a reconciled month or anything older", () => {
    const updates = deriveFeedBalances([st("nov", -10_000), st("oct", 5_000, { reconciled: true }), st("sep", 1_000)], 100_000);
    expect(updates.map((u) => u.id)).toEqual(["nov"]);
  });

  it("stops at a month holding a line the manager typed", () => {
    const updates = deriveFeedBalances([st("nov", 0, { feedOwned: false }), st("oct", 1)], 50_000);
    expect(updates).toEqual([]);
  });

  it("writes nothing when the balances already agree", () => {
    expect(deriveFeedBalances([st("nov", -500, { openingBalanceCents: 1_500, closingBalanceCents: 1_000 })], 1_000)).toEqual([]);
  });
});
