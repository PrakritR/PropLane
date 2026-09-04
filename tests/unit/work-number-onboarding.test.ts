/**
 * AXI-132 — "Work number field is missing / set up work number should be here
 * aswell", on the Connect Google services signup step.
 */
import { describe, expect, it } from "vitest";
import {
  shouldOfferWorkNumberSetup,
  workNumberOnboardingPhone,
} from "@/lib/sms/work-number-onboarding";

describe("work number card on the signup step", () => {
  it("offers setup to a manager who can provision one", () => {
    expect(
      shouldOfferWorkNumberSetup({ workspaceRole: "primary", canRequest: true, number: null }),
    ).toBe(true);
  });

  it("shows the number a manager already holds", () => {
    const status = {
      workspaceRole: "primary" as const,
      canRequest: false,
      provisioningAvailable: false,
      number: { phoneNumber: "+12065550100" },
    };
    expect(shouldOfferWorkNumberSetup(status)).toBe(true);
    expect(workNumberOnboardingPhone(status)).toBe("+12065550100");
  });

  it("never offers it to a pure co-manager", () => {
    // They text the OWNER's number by design, and the provisioning route refuses
    // them — the card would be a dead end.
    expect(
      shouldOfferWorkNumberSetup({
        workspaceRole: "co_manager",
        canRequest: true,
        provisioningAvailable: true,
        number: null,
      }),
    ).toBe(false);
  });

  it("stays hidden when provisioning is unavailable in this environment", () => {
    expect(
      shouldOfferWorkNumberSetup({
        workspaceRole: "primary",
        canRequest: false,
        provisioningAvailable: false,
        number: null,
      }),
    ).toBe(false);
  });

  it("shows nothing when the status could not be read", () => {
    // Signup is optional; a failed background read must not become an error.
    expect(shouldOfferWorkNumberSetup(null)).toBe(false);
    expect(workNumberOnboardingPhone(null)).toBe("");
  });

  it("treats a blank number string as no number", () => {
    expect(workNumberOnboardingPhone({ number: { phoneNumber: "   " } })).toBe("");
    expect(
      shouldOfferWorkNumberSetup({ workspaceRole: "primary", number: { phoneNumber: "  " } }),
    ).toBe(false);
  });
});
