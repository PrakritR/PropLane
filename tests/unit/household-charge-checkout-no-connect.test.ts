import { describe, expect, it } from "vitest";
import { canCreditPlatformHold, platformHoldCreditKey } from "@/lib/stripe-platform-hold";

describe("household charge checkout without Connect", () => {
  it("treats a missing destination as a hold key, not a second credit", () => {
    expect(platformHoldCreditKey("household_charge", "cs_rent_1")).toBe("household_charge:cs_rent_1");
    expect(canCreditPlatformHold(null)).toBe(true);
    expect(
      canCreditPlatformHold({ source: "household_charge", sourceId: "cs_rent_1" }),
    ).toBe(false);
  });
});
