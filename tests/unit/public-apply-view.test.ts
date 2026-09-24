import { describe, expect, it } from "vitest";
import {
  publicApplyGateKey,
  publicApplyReturnPath,
  resolvePublicApplyView,
} from "@/lib/rental-application/public-apply-session";

/**
 * Regression coverage for the blank public apply page: a SIGNED-IN non-resident
 * (a manager or vendor renting a home) must be routed to create a separate
 * resident account, never a blank screen. The historical bug hid the account
 * prompt when signed in but never un-gated any other surface, leaving an empty
 * content area for anyone authenticated in another role.
 */
describe("resolvePublicApplyView", () => {
  const propertyId = "mgr-seed-4709a-8th-ave-ne";

  it("routes a signed-in resident with a property link straight to the wizard", () => {
    expect(
      resolvePublicApplyView({
        gateKey: propertyId,
        guestContinue: false,
        signedInNonResident: false,
        hasResidentRole: true,
      }),
    ).toBe("wizard");
  });

  it("routes a signed-in non-resident to create a resident account (the fixed blank-page case)", () => {
    expect(
      resolvePublicApplyView({ gateKey: propertyId, guestContinue: false, signedInNonResident: true }),
    ).toBe("signed-in-create-resident");
  });

  it("shows the anonymous account prompt for a signed-out visitor with a property link", () => {
    expect(
      resolvePublicApplyView({ gateKey: propertyId, guestContinue: false, signedInNonResident: false }),
    ).toBe("account-prompt");
  });

  it("gates portfolio apply links the same way as a single-property link", () => {
    const gateKey = publicApplyGateKey({ portfolioPropertyIds: ["mgr-b", "mgr-a"] });
    expect(gateKey).toBe("portfolio:mgr-a,mgr-b");
    expect(
      resolvePublicApplyView({ gateKey, guestContinue: false, signedInNonResident: true }),
    ).toBe("signed-in-create-resident");
    expect(publicApplyReturnPath({ propertyId })).toBe(
      `/resident/applications/apply?propertyId=${propertyId}`,
    );
    expect(publicApplyReturnPath({ portfolioPropertyIds: ["mgr-b", "mgr-a"] })).toBe(
      "/rent/apply?ids=mgr-a%2Cmgr-b",
    );
  });

  // PLAN-0924-1421 closed guest apply. A stale `guestContinue` — from an old
  // session key or an old caller — must not unlock the wizard.
  it("keeps a signed-in non-resident gated even when guestContinue is true", () => {
    expect(
      resolvePublicApplyView({ gateKey: propertyId, guestContinue: true, signedInNonResident: true }),
    ).toBe("signed-in-create-resident");
  });

  it("keeps a signed-out visitor gated even when guestContinue is true", () => {
    expect(
      resolvePublicApplyView({ gateKey: propertyId, guestContinue: true, signedInNonResident: false }),
    ).toBe("account-prompt");
  });

  it("still opens the wizard for the applicant's own tokened resume link", () => {
    expect(
      resolvePublicApplyView({
        gateKey: propertyId,
        signedInNonResident: false,
        resumeFromEmailLink: true,
      }),
    ).toBe("wizard");
  });

  it("shows the wizard immediately when there is no property link, regardless of session", () => {
    for (const signedInNonResident of [true, false]) {
      expect(
        resolvePublicApplyView({ gateKey: "", guestContinue: false, signedInNonResident }),
      ).toBe("wizard");
      expect(
        resolvePublicApplyView({ gateKey: "   ", guestContinue: false, signedInNonResident }),
      ).toBe("wizard");
    }
  });

  it("only ever renders one real surface — the gate is never blank", () => {
    for (const guestContinue of [true, false]) {
      for (const signedInNonResident of [true, false]) {
        const view = resolvePublicApplyView({ gateKey: propertyId, guestContinue, signedInNonResident });
        expect(["account-prompt", "signed-in-create-resident", "wizard"]).toContain(view);
      }
    }
  });
});
