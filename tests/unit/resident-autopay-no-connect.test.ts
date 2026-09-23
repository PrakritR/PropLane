import { describe, expect, it } from "vitest";
import { connectAccountReadyForAchPayouts } from "@/lib/stripe-connect";

describe("autopay without Connect", () => {
  it("treats a missing bank as not ready, so the charge stays on the platform hold", () => {
    expect(
      connectAccountReadyForAchPayouts({
        id: "acct_new",
        object: "account",
        capabilities: { transfers: "inactive" },
        payouts_enabled: false,
      } as never),
    ).toBe(false);
    expect(
      connectAccountReadyForAchPayouts({
        id: "acct_ready",
        object: "account",
        capabilities: { transfers: "active" },
        payouts_enabled: true,
      } as never),
    ).toBe(true);
  });
});
