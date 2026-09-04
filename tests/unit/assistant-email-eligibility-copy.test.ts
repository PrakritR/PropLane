import { describe, expect, it } from "vitest";
import {
  assistantEmailEligibilityError,
  assistantEmailEntitlementIsUnverified,
  assistantEmailUpsellMessage,
} from "@/lib/manager-assistant-email/assistant-email-eligibility-copy";

describe("assistant email eligibility copy", () => {
  it("treats unreadable entitlements as unverified", () => {
    expect(
      assistantEmailEntitlementIsUnverified({ eligible: false, reason: "plan_unreadable" }),
    ).toBe(true);
    expect(
      assistantEmailEntitlementIsUnverified({ eligible: false, reason: "free" }),
    ).toBe(false);
  });

  it("does not upsell paid-or-unknown plans that have not been reconciled yet", () => {
    expect(
      assistantEmailUpsellMessage("paid", { eligible: false, reason: "plan_unreadable" }),
    ).toBeNull();
    expect(
      assistantEmailUpsellMessage("free", { eligible: false, reason: "free" }),
    ).toContain("paid Pro or Business");
  });

  it("returns actionable errors after reconciliation fails", () => {
    expect(
      assistantEmailEligibilityError("paid", { eligible: false, reason: "plan_unreadable" }),
    ).toContain("Check eligibility");
  });
});
