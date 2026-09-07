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

  it("AXI-158: offers it to a co-manager the server says may request one", () => {
    // This used to refuse every co-manager, citing a provisioning route that
    // "refuses them". It does not — `canRequest` never consults the flag, the
    // POST never rejects on it, and the entitlement layer deliberately lets a
    // pure co-manager inherit an inviting owner's plan. Settings offers them the
    // request; hiding it at signup is why a co-manager never saw the offer.
    expect(
      shouldOfferWorkNumberSetup({
        workspaceRole: "co_manager",
        canRequest: true,
        provisioningAvailable: true,
        number: null,
      }),
    ).toBe(true);
  });

  it("still hides it from a co-manager the server says may NOT", () => {
    // The server's answer is the gate, for every role alike.
    expect(
      shouldOfferWorkNumberSetup({
        workspaceRole: "co_manager",
        canRequest: false,
        provisioningAvailable: false,
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

  it.each([123, {}, [], true])("ignores a malformed phoneNumber (%j) without a trim error", (phoneNumber) => {
    const status = { number: { phoneNumber: phoneNumber as unknown as string } };
    expect(() => workNumberOnboardingPhone(status)).not.toThrow();
    expect(workNumberOnboardingPhone(status)).toBe("");
    expect(shouldOfferWorkNumberSetup({ workspaceRole: "primary", ...status })).toBe(false);
  });

  it("keeps a JSON-number work number so an existing account still sees it", () => {
    const status = { number: { phoneNumber: 18559168031 as unknown as string } };
    expect(workNumberOnboardingPhone(status)).toBe("+18559168031");
    expect(shouldOfferWorkNumberSetup({ workspaceRole: "primary", ...status })).toBe(true);
  });
});
