import { describe, expect, it, vi } from "vitest";
import { handleStripeTransferReversed } from "@/lib/stripe-webhook-financials";

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

describe("handleStripeTransferReversed", () => {
  it("clears stripe_transfer_id on matching ledger payment rows", async () => {
    const update = vi.fn(() => {
      const chain = {
        eq: vi.fn(() => chain),
        error: null,
      };
      return chain;
    });
    const select = vi.fn(() => {
      const chain = {
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn().mockResolvedValue({ data: { manager_user_id: "mgr_1" }, error: null }),
      };
      return chain;
    });
    const db = {
      from: vi.fn().mockReturnValue({ select, update }),
    };

    await handleStripeTransferReversed(db as never, {
      id: "tr_reversed_1",
      object: "transfer",
      amount: 1000,
      source_transaction: "ch_test_1",
    } as never);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_transfer_id: null,
      }),
    );
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
