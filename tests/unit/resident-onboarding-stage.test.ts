import { describe, expect, it } from "vitest";
import {
  normalizeResidentLeaseFiling,
  resolveResidentOnboardingStage,
} from "@/lib/resident-onboarding/resolve-onboarding-stage";

/**
 * The ladder in `resolve-onboarding-stage.ts`, case by case.
 *
 * This is the table both Add-resident surfaces now agree on. Before it existed
 * the residents list produced an Active/approved row for every save and the
 * document import derived a bucket from the parse, so the same resident landed
 * in two different places depending on which button the manager pressed.
 */
describe("resolveResidentOnboardingStage", () => {
  it("leaves a name-and-email-only resident pending, not active", () => {
    const stage = resolveResidentOnboardingStage({
      name: "Jane Smith",
      email: "jane@example.com",
    });
    expect(stage.bucket).toBe("pending");
    expect(stage.stage).toBe("Application");
    expect(stage.externallySignedLease).toBe(false);
    expect(stage.readyToActivate).toBe(false);
  });

  it("approves once the resident is placed in a property", () => {
    const stage = resolveResidentOnboardingStage({
      name: "Jane Smith",
      email: "jane@example.com",
      propertyId: "prop-1",
    });
    expect(stage.bucket).toBe("approved");
    expect(stage.stage).toBe("Active");
    expect(stage.externallySignedLease).toBe(false);
    expect(stage.readyToActivate).toBe(false);
  });

  it("keeps a DRAFT lease out of the executed state", () => {
    const stage = resolveResidentOnboardingStage({
      propertyId: "prop-1",
      leaseFiling: "draft",
    });
    expect(stage.bucket).toBe("approved");
    // The flag that unlocks the resident's Services stage must stay off for a
    // lease that still needs signatures.
    expect(stage.externallySignedLease).toBe(false);
    expect(stage.readyToActivate).toBe(false);
  });

  it("marks a SIGNED lease executed and ready to activate", () => {
    const stage = resolveResidentOnboardingStage({
      propertyId: "prop-1",
      leaseFiling: "signed",
    });
    expect(stage.bucket).toBe("approved");
    expect(stage.externallySignedLease).toBe(true);
    expect(stage.readyToActivate).toBe(true);
  });

  it("approves on a filed lease even when the property was left blank", () => {
    const stage = resolveResidentOnboardingStage({ leaseFiling: "signed" });
    expect(stage.bucket).toBe("approved");
    expect(stage.readyToActivate).toBe(true);
  });

  it("never invents a placement — an unplaced resident is still told to add one", () => {
    const stage = resolveResidentOnboardingStage({ leaseFiling: "none", propertyId: "  " });
    expect(stage.bucket).toBe("pending");
    expect(stage.summary).toMatch(/add a property/i);
  });

  it("produces the same result from both surfaces' shapes for identical input", () => {
    const fromResidentsList = resolveResidentOnboardingStage({
      name: "Jane",
      email: "jane@example.com",
      propertyId: "prop-1",
      roomChoice: "prop-1::room-2",
      monthlyRent: 875,
      leaseFiling: "signed",
    });
    const fromDocumentImport = resolveResidentOnboardingStage({
      name: "Jane",
      email: "jane@example.com",
      propertyId: "prop-1",
      leaseFiling: "signed",
    });
    expect(fromResidentsList.bucket).toBe(fromDocumentImport.bucket);
    expect(fromResidentsList.stage).toBe(fromDocumentImport.stage);
    expect(fromResidentsList.externallySignedLease).toBe(
      fromDocumentImport.externallySignedLease,
    );
  });
});

describe("normalizeResidentLeaseFiling", () => {
  it("is an allowlist — an unknown value falls to the weakest filing", () => {
    expect(normalizeResidentLeaseFiling("signed")).toBe("signed");
    expect(normalizeResidentLeaseFiling("draft")).toBe("draft");
    for (const raw of [undefined, null, "", "SIGNED", "executed", "yes", true, 1, {}]) {
      expect(normalizeResidentLeaseFiling(raw)).toBe("none");
    }
  });
});
